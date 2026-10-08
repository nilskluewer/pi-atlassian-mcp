/**
 * Confluence page-tree authorization for the Atlassian MCP bridge.
 *
 * A page scope is an authorization boundary for Confluence mutations, not
 * prompt guidance. Every write is checked immediately before it is sent to
 * the MCP server. Reads and unrelated Jira tools remain available so a user
 * can gather context without granting the agent write access to that content.
 */

const PAGE_ID_PATTERN = /^\d+$/;
const SPACE_ID_PATTERN = /^[A-Za-z0-9_~:-]{1,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLOUD_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.atlassian\.net$/;
const MAX_SCOPE_TITLE_CHARS = 200;
const MAX_DESCENDANT_PAGES = 250;
const MAX_DESCENDANT_REQUESTS = 20;
/** Confluence rejects descendant requests deeper than this. Deeper pages rely on the CQL ancestor check. */
const MAX_DESCENDANT_DEPTH = 10;

export interface PageScope {
	/** Atlassian site hostname, for example `rewe.atlassian.net`. */
	siteHost: string;
	/** Canonical Atlassian cloud UUID when it has been resolved. */
	cloudId?: string;
	/** The Confluence page that forms the root of this scope. */
	rootPageId: string;
	/** Metadata cached after validating the root page. */
	spaceId?: string;
	title?: string;
}

export interface PageMetadata {
	id: string;
	spaceId?: string;
	title?: string;
	ancestorIds: string[];
	parentId?: string;
	hasHierarchy: boolean;
}

/** Narrow adapter used for both real MCP clients and offline test doubles. */
export type ScopeCallTool = (
	name: string,
	arguments_: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<unknown>;

export type PageScopeToolClass = "confluence-write" | "confluence-read" | "other";

const CONFLUENCE_WRITE_TOOLS = new Set([
	"createConfluencePage",
	"updateConfluencePage",
	"createConfluenceFooterComment",
	"createConfluenceInlineComment",
]);

const CONFLUENCE_READ_TOOLS = new Set([
	"getConfluencePage",
	"getConfluencePageDescendants",
	"getConfluenceSpaces",
	"getPagesInConfluenceSpace",
	"getConfluencePageFooterComments",
	"getConfluencePageInlineComments",
	"getConfluenceCommentChildren",
	"searchConfluenceUsingCql",
	"search",
	"fetch",
]);

/** Tools that never touch Confluence content. */
const UNRELATED_TOOLS = new Set(["atlassianUserInfo", "getAccessibleAtlassianResources", "getContentFormatGuide"]);

/**
 * Classify by an explicit allowlist first, then fail closed for newly added
 * Confluence-like tools. Unknown Jira or metadata tools remain unaffected.
 */
export function classifyPageScopeTool(name: string): PageScopeToolClass {
	if (CONFLUENCE_WRITE_TOOLS.has(name)) return "confluence-write";
	if (CONFLUENCE_READ_TOOLS.has(name)) return "confluence-read";
	if (UNRELATED_TOOLS.has(name)) return "other";
	// Jira tools such as addCommentToJiraIssue must not match the Confluence keywords below.
	if (/jira|issue|worklog/i.test(name) && !/confluence/i.test(name)) return "other";
	if (/confluence|page|comment|blogpost|attachment|whiteboard|database|content/i.test(name)) return "confluence-write";
	return "other";
}

export class PageScopeDeniedError extends Error {
	readonly pageScopeDenied = true;

	constructor(message: string) {
		super(message);
		this.name = "PageScopeDeniedError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
	const text = stringValue(value);
	if (!text) return undefined;
	const cleaned = text.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
	if (!cleaned) return undefined;
	return cleaned.length > maxChars ? cleaned.slice(0, maxChars - 1) + "…" : cleaned;
}

/** Normalize a cloud/site value accepted by the Atlassian tools. */
export function normalizeCloudId(value: unknown): string | undefined {
	const raw = stringValue(value);
	if (!raw) return undefined;

	let candidate = raw;
	try {
		if (raw.includes("://")) {
			const parsed = new URL(raw);
			if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.pathname !== "/" && parsed.pathname !== "")) {
				return undefined;
			}
			candidate = parsed.hostname;
		}
	} catch {
		return undefined;
	}

	candidate = candidate.toLowerCase().replace(/\.$/, "");
	if (CLOUD_HOST_PATTERN.test(candidate) || UUID_PATTERN.test(candidate)) return candidate;
	return undefined;
}

export function normalizeSiteHost(value: unknown): string | undefined {
	const raw = stringValue(value);
	if (!raw) return undefined;
	if (raw.includes("://")) {
		try {
			const parsed = new URL(raw);
			if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
			const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
			return CLOUD_HOST_PATTERN.test(host) ? host : undefined;
		} catch {
			return undefined;
		}
	}
	const normalized = normalizeCloudId(raw);
	return normalized && CLOUD_HOST_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizedUuid(value: unknown): string | undefined {
	const normalized = normalizeCloudId(value);
	return normalized && UUID_PATTERN.test(normalized) ? normalized : undefined;
}

/** Parse a normal Confluence page URL into a scope. */
export function parseConfluencePageUrl(value: string): PageScope | undefined {
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;

	const siteHost = normalizeSiteHost(parsed.origin);
	if (!siteHost) return undefined;

	const parts = parsed.pathname.split("/").filter(Boolean);
	const wikiIndex = parts.findIndex((part) => part.toLowerCase() === "wiki");
	if (wikiIndex < 0 || parts[wikiIndex + 1]?.toLowerCase() !== "spaces") return undefined;
	if (parts[wikiIndex + 3]?.toLowerCase() !== "pages") return undefined;

	const rootPageId = parts[wikiIndex + 4];
	if (!rootPageId || !PAGE_ID_PATTERN.test(rootPageId)) return undefined;

	return { siteHost, rootPageId };
}

/** Validate and normalize a config entry without accepting arbitrary objects. */
export function normalizePageScope(value: unknown): PageScope | undefined {
	if (!isRecord(value)) return undefined;
	const rawCloudId = stringValue(value.cloudId);
	const siteHost = normalizeSiteHost(value.siteHost) ?? normalizeSiteHost(rawCloudId);
	const cloudId = normalizedUuid(rawCloudId);
	const rootPageId = stringValue(value.rootPageId);
	if (!siteHost || !rootPageId || !PAGE_ID_PATTERN.test(rootPageId)) return undefined;

	const spaceId = stringValue(value.spaceId);
	if (spaceId && !SPACE_ID_PATTERN.test(spaceId)) return undefined;

	const title = boundedText(value.title, MAX_SCOPE_TITLE_CHARS);
	return {
		siteHost,
		...(cloudId ? { cloudId } : {}),
		rootPageId,
		...(spaceId ? { spaceId } : {}),
		...(title ? { title } : {}),
	};
}

export function pageScopeKey(scope: Pick<PageScope, "siteHost" | "rootPageId">): string {
	return `${scope.siteHost}:${scope.rootPageId}`;
}

export function deduplicatePageScopes(scopes: Iterable<PageScope>): PageScope[] {
	const out: PageScope[] = [];
	const seen = new Set<string>();
	for (const raw of scopes) {
		const scope = normalizePageScope(raw);
		if (!scope) continue;
		const key = pageScopeKey(scope);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(scope);
	}
	return out;
}

function stripJsonFence(text: string): string {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenced?.[1]?.trim() ?? trimmed;
}

function payloadsFromResult(result: unknown): unknown[] {
	const payloads: unknown[] = [result];
	if (!isRecord(result) || !Array.isArray(result.content)) return payloads;

	for (const part of result.content) {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
		try {
			payloads.push(JSON.parse(stripJsonFence(part.text)));
		} catch {
			// Some MCP servers return markdown. Authorization fails closed if the
			// hierarchy or resource identity cannot be proven from the result.
		}
	}
	return payloads;
}

function walkRecords(value: unknown, visitor: (record: Record<string, unknown>) => void): void {
	const seen = new Set<object>();
	let nodes = 0;
	const visit = (current: unknown, depth: number): void => {
		if (nodes++ > 10_000 || depth > 20) return;
		if (Array.isArray(current)) {
			for (const item of current) visit(item, depth + 1);
			return;
		}
		if (!isRecord(current)) return;
		if (seen.has(current)) return;
		seen.add(current);
		visitor(current);
		for (const child of Object.values(current)) visit(child, depth + 1);
	};
	visit(value, 0);
}

function idFrom(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	const text = stringValue(value);
	return text && PAGE_ID_PATTERN.test(text) ? text : undefined;
}

function nestedId(record: Record<string, unknown>, key: string): string | undefined {
	const direct = idFrom(record[key]);
	if (direct) return direct;
	const nested = record[key];
	return isRecord(nested) ? idFrom(nested.id) : undefined;
}

function pageLike(record: Record<string, unknown>): boolean {
	return ["title", "spaceId", "space", "ancestors", "parentId", "parent", "body", "version", "status"].some(
		(key) => key in record,
	);
}

function ancestorIds(record: Record<string, unknown>): string[] {
	const ids: string[] = [];
	if (Array.isArray(record.ancestors)) {
		for (const ancestor of record.ancestors) {
			const id = isRecord(ancestor) ? idFrom(ancestor.id) : idFrom(ancestor);
			if (id) ids.push(id);
		}
	}
	const parentId = nestedId(record, "parentId") ?? nestedId(record, "parent");
	if (parentId) ids.push(parentId);
	return [...new Set(ids)];
}

/** Extract page metadata from the JSON or text-wrapped result of an MCP call. */
export function extractPageMetadata(result: unknown, pageId: string): PageMetadata | undefined {
	let found: PageMetadata | undefined;
	for (const payload of payloadsFromResult(result)) {
		walkRecords(payload, (record) => {
			if (found || idFrom(record.id) !== pageId || !pageLike(record)) return;
			const space = isRecord(record.space) ? idFrom(record.space.id) : undefined;
			found = {
				id: pageId,
				spaceId: idFrom(record.spaceId) ?? space,
				title: boundedText(record.title, MAX_SCOPE_TITLE_CHARS),
				ancestorIds: ancestorIds(record),
				parentId: nestedId(record, "parentId") ?? nestedId(record, "parent"),
				hasHierarchy: "ancestors" in record || "parentId" in record || "parent" in record,
			};
		});
		if (found) return found;
	}
	return undefined;
}

function isErrorResult(result: unknown): boolean {
	return isRecord(result) && result.isError === true;
}

function containsPageId(result: unknown, pageId: string): boolean {
	let found = false;
	for (const payload of payloadsFromResult(result)) {
		walkRecords(payload, (record) => {
			if (!found && idFrom(record.id) === pageId && pageLike(record)) found = true;
		});
		if (found) return true;
	}
	return false;
}

function pageIdsInResult(result: unknown): string[] {
	const ids = new Set<string>();
	for (const payload of payloadsFromResult(result)) {
		walkRecords(payload, (record) => {
			const id = idFrom(record.id);
			if (id && pageLike(record)) ids.add(id);
		});
	}
	return [...ids];
}

function nextCursor(result: unknown): string | undefined {
	let cursor: string | undefined;
	for (const payload of payloadsFromResult(result)) {
		walkRecords(payload, (record) => {
			if (cursor) return;
			for (const key of ["nextCursor", "next_cursor"]) {
				const value = stringValue(record[key]);
				if (value) {
					cursor = value;
					return;
				}
			}
			const links = isRecord(record._links) ? record._links : undefined;
			const next = links && stringValue(links.next);
			if (next) {
				try {
					cursor = new URL(next).searchParams.get("cursor") ?? undefined;
				} catch {
					// Ignore malformed untrusted links.
				}
			}
		});
		if (cursor) return cursor;
	}
	return undefined;
}

interface CloudResource {
	cloudId: string;
	siteHost: string;
}

function extractCloudResources(result: unknown): CloudResource[] {
	const resources: CloudResource[] = [];
	const seen = new Set<string>();
	for (const payload of payloadsFromResult(result)) {
		walkRecords(payload, (record) => {
			const cloudId = normalizedUuid(record.id);
			const url = stringValue(record.url) ?? stringValue(record.baseUrl) ?? stringValue(record.href);
			const siteHost = normalizeSiteHost(url);
			if (!cloudId || !siteHost) return;
			const key = `${cloudId}:${siteHost}`;
			if (seen.has(key)) return;
			seen.add(key);
			resources.push({ cloudId, siteHost });
		});
	}
	return resources;
}

function scopeCloudValue(scope: PageScope): string {
	return scope.cloudId ?? scope.siteHost;
}

export class PageScopePolicy {
	private readonly scopes: PageScope[];
	private readonly metadataCache = new Map<string, PageMetadata | null>();
	private readonly resourceMap = new Map<string, string>();
	private readonly createdPageKeys = new Set<string>();
	private resourcesLoaded = false;

	constructor(scopes: Iterable<PageScope>) {
		this.scopes = deduplicatePageScopes(scopes);
	}

	getScopes(): PageScope[] {
		return this.scopes.map((scope) => ({ ...scope }));
	}

	/** Kept for picker integrations. A page scope constrains writes, not tools. */
	canExposeTool(_name: string): boolean {
		return true;
	}

	/** Remember pages created through an authorized call until this session ends. */
	noteSuccessfulCall(name: string, args: Record<string, unknown>, result: unknown): void {
		if (name !== "createConfluencePage" || isErrorResult(result)) return;
		const normalized = normalizeCloudId(args.cloudId);
		if (!normalized) return;
		const matching = this.scopes.filter(
			(scope) => normalized === scope.siteHost || normalized === scope.cloudId || this.resourceMap.get(scope.siteHost) === normalized,
		);
		for (const scope of matching) {
			for (const pageId of pageIdsInResult(result)) this.createdPageKeys.add(`${pageScopeKey(scope)}:${pageId}`);
		}
	}

	async authorize(
		name: string,
		args: Record<string, unknown>,
		callTool: ScopeCallTool,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (this.scopes.length === 0) return args;
		const classification = classifyPageScopeTool(name);
		if (classification !== "confluence-write") return args;
		this.metadataCache.clear();

		if (!CONFLUENCE_WRITE_TOOLS.has(name)) {
			throw this.blocked(name, "the operation is not explicitly supported by the page-scope policy");
		}

		if (name === "createConfluencePage") {
			this.rejectBlogs(name, args);
			if (!stringValue(args.parentId)) {
				throw this.blocked(name, "new pages must specify a parent inside the configured page tree");
			}
			await this.requirePage(args.cloudId, args.parentId, callTool, signal);
			await this.requireSpace(args.cloudId, args.spaceId, callTool, signal);
			return args;
		}

		if (name === "updateConfluencePage") {
			this.rejectBlogs(name, args);
			await this.requirePage(args.cloudId, args.pageId, callTool, signal);
			if (args.parentId !== undefined) await this.requirePage(args.cloudId, args.parentId, callTool, signal);
			if (args.spaceId !== undefined) await this.requireSpace(args.cloudId, args.spaceId, callTool, signal);
			return args;
		}

		this.rejectBlogs(name, args);
		// A reply or a comment on an attachment targets that object, not pageId,
		// so pageId alone cannot prove where the comment lands.
		for (const key of ["parentCommentId", "attachmentId", "customContentId"]) {
			if (args[key] !== undefined && args[key] !== null && args[key] !== "") {
				throw this.blocked(name, `${key} is not supported while a page scope is active; comment on the page itself`);
			}
		}
		if (!stringValue(args.pageId)) {
			throw this.blocked(name, "pass pageId so the comment target can be checked against the page scope");
		}
		await this.requirePage(args.cloudId, args.pageId, callTool, signal);
		return args;
	}

	private blocked(name: string, reason: string): PageScopeDeniedError {
		return new PageScopeDeniedError(`Atlassian page scope blocked ${name}: ${reason}.`);
	}

	private rejectBlogs(name: string, args: Record<string, unknown>): void {
		if (args.contentType === "blog") throw this.blocked(name, "blog posts are outside a page-tree scope");
	}

	private async matchingScopes(cloudValue: unknown, callTool: ScopeCallTool, signal?: AbortSignal): Promise<PageScope[]> {
		const normalized = normalizeCloudId(cloudValue);
		if (!normalized) throw this.blocked("Confluence operation", "the cloudId is invalid");
		let matching = this.scopes.filter(
			(scope) => normalized === scope.siteHost || normalized === scope.cloudId,
		);
		if (matching.length > 0 || !UUID_PATTERN.test(normalized)) return matching;

		await this.loadCloudResources(callTool, signal);
		matching = this.scopes.filter(
			(scope) => normalized === scope.cloudId || this.resourceMap.get(scope.siteHost) === normalized,
		);
		return matching;
	}

	private async loadCloudResources(callTool: ScopeCallTool, signal?: AbortSignal): Promise<void> {
		if (this.resourcesLoaded) return;
		this.resourcesLoaded = true;
		const result = await callTool("getAccessibleAtlassianResources", {}, signal);
		if (isErrorResult(result)) return;
		for (const resource of extractCloudResources(result)) this.resourceMap.set(resource.siteHost, resource.cloudId);
	}

	private async requirePage(
		cloudValue: unknown,
		pageValue: unknown,
		callTool: ScopeCallTool,
		signal?: AbortSignal,
	): Promise<PageScope> {
		const pageId = stringValue(pageValue);
		if (!pageId || !PAGE_ID_PATTERN.test(pageId)) {
			throw this.blocked("Confluence operation", "the pageId is invalid");
		}
		const matching = await this.matchingScopes(cloudValue, callTool, signal);
		if (matching.length === 0) throw this.blocked("Confluence operation", "the cloudId is outside the configured page scopes");
		for (const scope of matching) {
			if (scope.rootPageId === pageId || this.createdPageKeys.has(`${pageScopeKey(scope)}:${pageId}`)) return scope;
			if (await this.isDescendant(scope, pageId, callTool, signal)) return scope;
		}
		throw this.blocked("Confluence operation", `page ${pageId} is outside the configured page tree`);
	}

	private async isDescendant(
		scope: PageScope,
		pageId: string,
		callTool: ScopeCallTool,
		signal?: AbortSignal,
	): Promise<boolean> {
		// Query the scoped ancestor first. This is normally one cheap request and
		// never reads an arbitrary candidate page outside the configured tree.
		const searchResult = await callTool(
			"searchConfluenceUsingCql",
			{
				cloudId: scopeCloudValue(scope),
				cql: `ancestor = ${scope.rootPageId} AND id = ${pageId} AND type = page`,
				limit: 1,
			},
			signal,
		);
		if (!isErrorResult(searchResult) && containsPageId(searchResult, pageId)) return true;

		// If the search index is unavailable or the result is not parseable, use
		// the page-tree endpoint with pagination as a fail-closed fallback.
		let cursor: string | undefined;
		for (let request = 0; request < MAX_DESCENDANT_REQUESTS; request++) {
			const descendantResult = await callTool(
				"getConfluencePageDescendants",
				{
					cloudId: scopeCloudValue(scope),
					pageId: scope.rootPageId,
					limit: MAX_DESCENDANT_PAGES,
					depth: MAX_DESCENDANT_DEPTH,
					...(cursor ? { cursor } : {}),
				},
				signal,
			);
			if (isErrorResult(descendantResult)) return false;
			if (containsPageId(descendantResult, pageId)) return true;
			const next = nextCursor(descendantResult);
			if (!next || next === cursor) break;
			cursor = next;
		}
		return false;
	}

	private async requireSpace(
		cloudValue: unknown,
		spaceValue: unknown,
		callTool: ScopeCallTool,
		signal?: AbortSignal,
	): Promise<void> {
		const spaceId = stringValue(spaceValue);
		if (!spaceId || !SPACE_ID_PATTERN.test(spaceId)) {
			throw this.blocked("Confluence operation", "the spaceId is invalid or missing");
		}
		const matching = await this.matchingScopes(cloudValue, callTool, signal);
		if (matching.length === 0) throw this.blocked("Confluence operation", "the cloudId is outside the configured page scopes");
		for (const scope of matching) {
			const expected = await this.rootSpaceId(scope, callTool, signal);
			if (expected && expected === spaceId) return;
		}
		throw this.blocked("Confluence operation", `space ${spaceId} is outside the configured page scopes`);
	}

	private async rootSpaceId(scope: PageScope, callTool: ScopeCallTool, signal?: AbortSignal): Promise<string | undefined> {
		const cacheKey = `${pageScopeKey(scope)}:root`;
		const cached = this.metadataCache.get(cacheKey);
		if (cached?.spaceId) return cached.spaceId;
		const result = await callTool(
			"getConfluencePage",
			{ cloudId: scopeCloudValue(scope), pageId: scope.rootPageId, contentFormat: "markdown" },
			signal,
		);
		if (isErrorResult(result)) return undefined;
		const metadata = extractPageMetadata(result, scope.rootPageId);
		this.metadataCache.set(cacheKey, metadata ?? null);
		return metadata?.spaceId;
	}
}

/** Validate a root page and retain safe metadata for later create operations. */
export async function validatePageScopeRoot(
	scope: PageScope,
	callTool: ScopeCallTool,
	signal?: AbortSignal,
): Promise<PageScope> {
	const normalized = normalizePageScope(scope);
	if (!normalized) throw new Error("Invalid Confluence page scope.");
	const resourceResult = await callTool("getAccessibleAtlassianResources", {}, signal);
	const resources = isErrorResult(resourceResult) ? [] : extractCloudResources(resourceResult);
	const resource = resources.find((candidate) => candidate.siteHost === normalized.siteHost);
	const result = await callTool(
		"getConfluencePage",
		{ cloudId: resource?.cloudId ?? normalized.siteHost, pageId: normalized.rootPageId, contentFormat: "markdown" },
		signal,
	);
	if (isErrorResult(result)) throw new Error("Confluence rejected the configured root page.");
	const metadata = extractPageMetadata(result, normalized.rootPageId);
	if (metadata?.id !== normalized.rootPageId) {
		throw new Error("Confluence returned a different page for the configured root page.");
	}
	return {
		...normalized,
		...(resource?.cloudId ? { cloudId: resource.cloudId } : {}),
		...(metadata?.spaceId ? { spaceId: metadata.spaceId } : {}),
		...(metadata?.title ? { title: metadata.title } : {}),
	};
}

export const PAGE_SCOPE_TOOL_NAMES = [...CONFLUENCE_WRITE_TOOLS];
