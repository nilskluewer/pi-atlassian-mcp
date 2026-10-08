import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyPageScopeTool,
	deduplicatePageScopes,
	extractPageMetadata,
	normalizePageScope,
	PageScopeDeniedError,
	PageScopePolicy,
	parseConfluencePageUrl,
} from "../extensions/atlassian-mcp/scope.ts";
import { writeFile, mkdir } from "node:fs/promises";
import { openPagesPanel } from "../extensions/atlassian-mcp/pages-panel.ts";
import { inheritedPageScopes, loadEffectiveConfig, PAGE_SCOPES_ENV, registerMcpTool, saveConfig } from "../extensions/atlassian-mcp/index.ts";

let passed = 0;
function check(name: string, fn: () => void) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

async function checkAsync(name: string, fn: () => Promise<void>) {
	await fn();
	passed++;
	console.log(`  ok  ${name}`);
}

const root = { siteHost: "rewe.atlassian.net", rootPageId: "1657441488", spaceId: "42", title: "Agentic Engineering" };
const child = "1657441490";
const outside = "9999999999";

function pageResult(id: string, ancestors: string[] = [], spaceId = "42") {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					id,
					title: id === root.rootPageId ? root.title : `Page ${id}`,
					spaceId,
					ancestors: ancestors.map((ancestorId) => ({ id: ancestorId })),
				}),
			},
		],
	};
}

console.log("page scope parsing");
check("parses the page URL from the request", () => {
	assert.deepEqual(parseConfluencePageUrl("https://rewe.atlassian.net/wiki/spaces/ATools/pages/1657441488/Agentic+Engineering"), {
		siteHost: "rewe.atlassian.net",
		rootPageId: "1657441488",
	});
});
check("rejects non-Confluence or malformed page URLs", () => {
	for (const value of [
		"http://rewe.atlassian.net/wiki/spaces/ATools/pages/1657441488",
		"https://evil.example/wiki/spaces/ATools/pages/1657441488",
		"https://rewe.atlassian.net/wiki/spaces/ATools/pages/not-a-page",
		"https://rewe.atlassian.net/wiki/pages/1657441488",
	]) {
		assert.equal(parseConfluencePageUrl(value), undefined, value);
	}
});
check("normalizes and deduplicates page scope config", () => {
	assert.deepEqual(
		deduplicatePageScopes([
			root,
			{ ...root, title: "same root" },
			{ siteHost: "rewe.atlassian.net", rootPageId: root.rootPageId },
		]),
		[root],
	);
	assert.equal(normalizePageScope({ siteHost: "evil.example", rootPageId: root.rootPageId }), undefined);
});
check("extracts hierarchy metadata from text-wrapped MCP results", () => {
	assert.deepEqual(extractPageMetadata(pageResult(child, [root.rootPageId]), child), {
		id: child,
		spaceId: "42",
		title: `Page ${child}`,
		ancestorIds: [root.rootPageId],
		parentId: undefined,
		hasHierarchy: true,
	});
});

console.log("page scope authorization");
check("does not remove read or Jira tools when a write scope is active", () => {
	const policy = new PageScopePolicy([root]);
	assert.equal(policy.canExposeTool("getConfluencePage"), true);
	assert.equal(policy.canExposeTool("updateConfluencePage"), true);
	assert.equal(policy.canExposeTool("getJiraIssue"), true);
	assert.equal(policy.canExposeTool("getPagesInConfluenceSpace"), true);
	assert.equal(policy.canExposeTool("deleteConfluencePage"), true);
});
await checkAsync("allows a descendant update without reading an out-of-scope candidate", async () => {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const callTool = async (name: string, args: Record<string, unknown>) => {
		calls.push({ name, args });
		if (name === "getConfluencePageDescendants") {
			return { content: [{ type: "text", text: JSON.stringify({ results: [{ id: child, title: "Child", spaceId: "42" }] }) }] };
		}
		if (name === "searchConfluenceUsingCql") return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
		throw new Error(`unexpected call ${name}`);
	};
	await new PageScopePolicy([root]).authorize(
		"updateConfluencePage",
		{ cloudId: root.siteHost, pageId: child, body: "new body" },
		callTool,
	);
	assert.equal(calls.some((call) => call.name === "getConfluencePage" && call.args.pageId === child), false);
	assert.equal(calls.some((call) => call.name === "getConfluencePageDescendants" && call.args.pageId === root.rootPageId), true);
});
await checkAsync("resolves canonical UUID cloud IDs through accessible resources", async () => {
	const calls: string[] = [];
	const cloudId = "123e4567-e89b-12d3-a456-426614174000";
	const callTool = async (name: string, args: Record<string, unknown>) => {
		calls.push(name);
		if (name === "getAccessibleAtlassianResources") {
			return { content: [{ type: "text", text: JSON.stringify([{ id: cloudId, url: "https://rewe.atlassian.net" }]) }] };
		}
		if (name === "searchConfluenceUsingCql") {
			return { content: [{ type: "text", text: JSON.stringify({ results: [{ id: child, title: "Child", spaceId: "42" }] }) }] };
		}
		throw new Error(`unexpected call ${name} ${JSON.stringify(args)}`);
	};
	await new PageScopePolicy([root]).authorize(
		"updateConfluencePage",
		{ cloudId, pageId: child, body: "new body" },
		callTool,
	);
	assert.equal(calls.includes("getAccessibleAtlassianResources"), true);
});
await checkAsync("blocks a page outside every configured tree", async () => {
	const calls: string[] = [];
	const callTool = async (name: string, args: Record<string, unknown>) => {
		calls.push(name);
		if (name === "getConfluencePageDescendants") return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
		if (name === "searchConfluenceUsingCql") return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
		throw new Error(`unexpected call ${name}`);
	};
	await assert.rejects(
		() => new PageScopePolicy([root]).authorize("updateConfluencePage", { cloudId: root.siteHost, pageId: outside, body: "wipe" }, callTool),
		/outside the configured page tree/,
	);
	assert.equal(calls.includes("getConfluencePage"), false);
});
await checkAsync("keeps reads available but denies unknown Confluence writes", async () => {
	const policy = new PageScopePolicy([root]);
	const args = { cloudId: "some-other-site.atlassian.net", pageId: outside };
	assert.deepEqual(await policy.authorize("getConfluencePage", args, async () => ({ content: [] })), args);
	await assert.rejects(
		() => policy.authorize("deleteConfluencePage", { cloudId: root.siteHost, pageId: root.rootPageId }, async () => ({ content: [] })),
		/operation is not explicitly supported/,
	);
});
await checkAsync("allows an authorized create to be updated before search indexing catches up", async () => {
	const policy = new PageScopePolicy([root]);
	const created = "1657441500";
	policy.noteSuccessfulCall("createConfluencePage", { cloudId: root.siteHost }, pageResult(created, [root.rootPageId]));
	await policy.authorize("updateConfluencePage", { cloudId: root.siteHost, pageId: created, body: "follow-up" }, async () => {
		throw new Error("newly created page should use the in-session allow set");
	});
});
await checkAsync("returns page-scope denials as authorization errors, not untrusted MCP data", async () => {
	let execute: ((...args: unknown[]) => Promise<unknown>) | undefined;
	const mockPi = {
		getAllTools: () => [],
		registerTool: (tool: { execute: (...args: unknown[]) => Promise<unknown> }) => {
			execute = tool.execute;
		},
	};
	registerMcpTool(
		mockPi as never,
		{ name: "updateConfluencePage", inputSchema: { type: "object", properties: {} } },
		async () => {
			throw new Error("MCP must not be called after a denied authorization");
		},
		new Set(),
		async () => {
			throw new PageScopeDeniedError("blocked by test policy");
		},
	);
	await assert.rejects(
		() => execute!("tool-call", {}, undefined, undefined, { ui: { notify: () => {} } }),
		(err: unknown) => err instanceof Error && err.message === "blocked by test policy",
	);
});
await checkAsync("requires an in-tree parent and verified root space for creates", async () => {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const callTool = async (name: string, args: Record<string, unknown>) => {
		calls.push({ name, args });
		if (name === "searchConfluenceUsingCql") return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
		if (name === "getConfluencePageDescendants") {
			return { content: [{ type: "text", text: JSON.stringify({ results: [{ id: child, title: "Child", spaceId: "42" }] }) }] };
		}
		if (name === "getConfluencePage" && args.pageId === root.rootPageId) return pageResult(root.rootPageId, [], "42");
		throw new Error(`unexpected call ${name}`);
	};
	await new PageScopePolicy([root]).authorize(
		"createConfluencePage",
		{ cloudId: root.siteHost, spaceId: "42", parentId: child, body: "new page" },
		callTool,
	);
	await assert.rejects(
		() => new PageScopePolicy([root]).authorize("createConfluencePage", { cloudId: root.siteHost, spaceId: "42", body: "root-level page" }, callTool),
		/must specify a parent/,
	);
	assert.equal(calls.some((call) => call.name === "getConfluencePage" && call.args.pageId === root.rootPageId), true);
});
await checkAsync("leaves read searches unchanged while restricting writes", async () => {
	const policy = new PageScopePolicy([root]);
	const args = { cloudId: root.siteHost, cql: "title ~ \"notes\" OR text ~ \"plan\"" };
	const authorized = await policy.authorize("searchConfluenceUsingCql", args, async () => ({ content: [] }));
	assert.deepEqual(authorized, args);
});

check("classifies Jira and metadata tools as unrelated to Confluence writes", () => {
	for (const name of ["addCommentToJiraIssue", "addWorklogToJiraIssue", "createIssueLink", "editJiraIssue", "getContentFormatGuide", "atlassianUserInfo", "getAccessibleAtlassianResources"]) {
		assert.equal(classifyPageScopeTool(name), "other", name);
	}
	for (const name of ["deleteConfluencePage", "createConfluenceBlogPost", "uploadAttachment"]) {
		assert.equal(classifyPageScopeTool(name), "confluence-write", name);
	}
});
await checkAsync("denies comment replies whose target cannot be proven from pageId", async () => {
	for (const key of ["parentCommentId", "attachmentId", "customContentId"]) {
		await assert.rejects(
			() => new PageScopePolicy([root]).authorize("createConfluenceFooterComment", { cloudId: root.siteHost, pageId: root.rootPageId, [key]: "123", body: "x" }, async () => {
				throw new Error("must not call MCP");
			}),
			new RegExp(key),
		);
	}
});
await checkAsync("requests descendants within the Confluence depth limit", async () => {
	let depth: unknown;
	const callTool = async (name: string, args: Record<string, unknown>) => {
		if (name === "getConfluencePageDescendants") depth = args.depth;
		return { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] };
	};
	await assert.rejects(() => new PageScopePolicy([root]).authorize("updateConfluencePage", { cloudId: root.siteHost, pageId: outside, body: "x" }, callTool));
	assert.equal(depth, 10);
});

console.log("pages panel (non-TUI fallback)");
await checkAsync("removes a page and applies the draft through select dialogs", async () => {
	const other = { siteHost: "rewe.atlassian.net", rootPageId: "1658063227", title: "Claude Code" };
	const answers = [`Remove: ${root.title} (${root.rootPageId})`, "▸ Save as project default"];
	const titles: string[] = [];
	const result = await openPagesPanel(
		{ mode: "rpc", ui: { custom: async () => { throw new Error("no components in rpc"); }, select: async (title) => { titles.push(title); return answers.shift(); } } },
		{ draft: [root, other], active: [root, other], source: "project default", canSaveProject: true },
	);
	assert.deepEqual(result, { action: "project", draft: [other] });
	assert.match(titles[0]!, /2 page trees/);
	assert.match(titles[1]!, /1 page tree,/);
});
await checkAsync("cancel in the fallback changes nothing", async () => {
	const result = await openPagesPanel(
		{ mode: "rpc", ui: { custom: async () => undefined as never, select: async () => undefined } },
		{ draft: [root], active: [root], source: "global default", canSaveProject: false },
	);
	assert.equal(result, undefined);
});

console.log("inherited page scope");
check("malformed inherited page scope state fails closed", () => {
	const previous = process.env[PAGE_SCOPES_ENV];
	try {
		for (const value of ["invalid", "{", "{}", "[]", JSON.stringify([{ siteHost: "evil.example", rootPageId: "1" }])]) {
			process.env[PAGE_SCOPES_ENV] = value;
			assert.equal(inheritedPageScopes(), "invalid", value);
		}
		process.env[PAGE_SCOPES_ENV] = JSON.stringify([root]);
		assert.deepEqual(inheritedPageScopes(), [root]);
		delete process.env[PAGE_SCOPES_ENV];
		assert.equal(inheritedPageScopes(), undefined);
	} finally {
		if (previous === undefined) delete process.env[PAGE_SCOPES_ENV];
		else process.env[PAGE_SCOPES_ENV] = previous;
	}
});

console.log("page scope config");
const projectDir = await mkdtemp(join(tmpdir(), "pi-atlassian-scope-test-"));
try {
	await checkAsync("persists page scopes with project defaults without touching Pi settings", async () => {
		await saveConfig("project", projectDir, { autoStart: true, enabledTools: ["getConfluencePage"], pageScopes: [root] });
		const effective = await loadEffectiveConfig(projectDir, true);
		assert.deepEqual(effective.config.pageScopes, [root]);
		await assert.rejects(() => readFile(join(projectDir, ".pi", "settings.json"), "utf8"));
	});
	await checkAsync("refuses a config file with an invalid page scope instead of dropping it", async () => {
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await writeFile(join(projectDir, ".pi", "atlassian-mcp.json"), JSON.stringify({ pageScopes: [{ siteHost: "evil.example", rootPageId: "1" }] }));
		await assert.rejects(() => loadEffectiveConfig(projectDir, true), /invalid pageScopes entry/);
	});
} finally {
	await rm(projectDir, { recursive: true, force: true });
}

console.log(`\n${passed} scope checks passed`);
