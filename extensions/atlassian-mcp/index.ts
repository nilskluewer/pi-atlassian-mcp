/**
 * Atlassian Rovo MCP bridge extension.
 *
 * Connects to the remote Atlassian MCP server (https://github.com/atlassian/atlassian-mcp-server)
 * via the `mcp-remote` stdio bridge (handles OAuth + token caching), discovers its tools,
 * and exposes a user-selectable subset of them as pi tools.
 *
 * Scope model:
 *   - The picker (/atlassian-tools) always changes the CURRENT SESSION only.
 *   - "Save as default" in the picker additionally persists the selection to
 *     ~/.pi/agent/atlassian-mcp.json so future sessions start with it.
 *   - `autoStart` controls whether saved defaults are applied on session_start.
 *     When false (the default), every session starts clean and you opt in per session.
 *
 * Tool hints:
 *   TOOL_GUIDELINES below attaches extra usage guidance to individual MCP tools.
 *   Add an entry keyed by the raw MCP tool name to teach the model a quirk the
 *   server's own description omits.
 *
 * Config file (~/.pi/agent/atlassian-mcp.json):
 *   { "autoStart": false, "enabledTools": ["jira_search", "jira_get_issue"] }
 *
 * Commands:
 *   /atlassian-tools      - pick tools for this session (optionally save as default)
 *   /atlassian-off        - deactivate all Atlassian tools for this session
 *   /atlassian-autostart  - toggle whether defaults auto-load in new sessions
 *   /atlassian-reconnect  - force a fresh connection (e.g. after re-auth)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_URL = "https://mcp.atlassian.com/v1/mcp";
const TOOL_PREFIX = "atlassian_";
const CONFIG_DIR = join(homedir(), CONFIG_DIR_NAME, "agent");
const CONFIG_PATH = join(CONFIG_DIR, "atlassian-mcp.json");

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema: unknown;
}

interface Config {
	/** Apply the saved selection automatically in every new session. */
	autoStart: boolean;
	/** Saved default selection, by raw MCP tool name. */
	enabledTools: string[];
}

type NotifyCtx = { ui: { notify: (m: string, t?: string) => void } };

/**
 * Extra system-prompt guidance per MCP tool, keyed by raw MCP tool name.
 *
 * These are hard-won usage lessons that the server's own tool descriptions do
 * not mention. They are injected into the Guidelines section only while the
 * corresponding tool is active, so they cost nothing when Atlassian is off.
 *
 * Guidelines must name their tool explicitly - they are appended flat, with no
 * grouping, so "this tool" would be ambiguous to the model.
 */
const TOOL_GUIDELINES: Record<string, string[]> = {
	getConfluencePage: [
		"When atlassian_getConfluencePage returns an empty or whitespace-only body, retry with contentFormat: \"html\" before concluding the page is empty. Pages built from macros (for example Aura panels) render as blank in markdown but carry their real content, headlines and links in the HTML form.",
		"When an atlassian_getConfluencePage body turns out to be only macro tiles or links, treat the page as a navigation hub rather than documentation, and call atlassian_getConfluencePageDescendants to locate the pages that hold the actual content.",
	],
	getConfluencePageDescendants: [
		"When listing results from atlassian_getConfluencePageDescendants, check each entry's status field and flag any draft pages, especially drafts whose title duplicates a published sibling, before relying on or citing them.",
	],
};

async function loadConfig(): Promise<Config> {
	try {
		const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
		return {
			autoStart: parsed.autoStart === true,
			enabledTools: Array.isArray(parsed.enabledTools) ? parsed.enabledTools : [],
		};
	} catch {
		return { autoStart: false, enabledTools: [] };
	}
}

async function saveConfig(config: Config): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

export default function atlassianMcpExtension(pi: ExtensionAPI) {
	let client: Client | undefined;
	let connecting: Promise<Client> | undefined;
	let discoveredTools: McpToolDef[] = [];
	const registeredNames = new Set<string>();

	/** Tools active in THIS session only. Never written to disk unless asked. */
	const sessionEnabled = new Set<string>();

	async function connect(ctx: NotifyCtx): Promise<Client> {
		if (client) return client;
		if (connecting) return connecting;

		connecting = (async () => {
			const transport = new StdioClientTransport({
				command: "npx",
				args: ["-y", "mcp-remote", SERVER_URL],
				stderr: "pipe",
			});
			const c = new Client({ name: "pi-atlassian-mcp", version: "0.1.0" }, { capabilities: {} });
			ctx.ui.notify("Connecting to Atlassian MCP - a browser window may open for login on first use.", "info");
			await c.connect(transport);
			client = c;
			return c;
		})();

		try {
			return await connecting;
		} finally {
			connecting = undefined;
		}
	}

	const toolNameFor = (mcpName: string) => `${TOOL_PREFIX}${mcpName}`;

	function registerMcpTool(def: McpToolDef) {
		const toolName = toolNameFor(def.name);
		if (registeredNames.has(toolName)) return;
		registeredNames.add(toolName);

		pi.registerTool({
			name: toolName,
			label: def.name,
			description: def.description ?? `Atlassian MCP tool: ${def.name}`,
			promptSnippet: `${def.description ?? def.name} (Atlassian)`,
			promptGuidelines: TOOL_GUIDELINES[def.name],
			// MCP inputSchema is plain JSON Schema; TypeBox schemas are plain
			// objects at runtime, so this is structurally compatible.
			parameters: def.inputSchema as never,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const c = await connect(ctx);
				const result = await c.callTool(
					{ name: def.name, arguments: params as Record<string, unknown> },
					undefined,
					{ signal },
				);
				const content = Array.isArray(result.content)
					? result.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => ({ type: "text" as const, text: part.text }))
					: [{ type: "text" as const, text: JSON.stringify(result) }];

				if (result.isError) {
					throw new Error(content.map((c) => c.text).join("\n") || "Atlassian MCP tool call failed");
				}
				return { content, details: { raw: result } };
			},
		});
	}

	async function discoverTools(ctx: NotifyCtx): Promise<McpToolDef[]> {
		const c = await connect(ctx);
		const { tools } = await c.listTools();
		discoveredTools = tools as McpToolDef[];
		return discoveredTools;
	}

	/**
	 * Make the session selection the effective active-tool set.
	 * Non-Atlassian tools are left untouched.
	 */
	function syncActiveTools() {
		const ourNames = new Set([...registeredNames]);
		const others = pi.getActiveTools().filter((n) => !ourNames.has(n));
		pi.setActiveTools([...new Set([...others, ...[...sessionEnabled].map(toolNameFor)])]);
	}

	async function activate(names: Iterable<string>, ctx: NotifyCtx) {
		const wanted = new Set(names);
		if (wanted.size === 0) {
			sessionEnabled.clear();
			syncActiveTools();
			return;
		}
		const tools = discoveredTools.length > 0 ? discoveredTools : await discoverTools(ctx);
		sessionEnabled.clear();
		for (const def of tools) {
			if (wanted.has(def.name)) {
				registerMcpTool(def);
				sessionEnabled.add(def.name);
			}
		}
		syncActiveTools();
	}

	pi.on("session_start", async (_event, ctx) => {
		const config = await loadConfig();
		if (!config.autoStart || config.enabledTools.length === 0) return;
		try {
			await activate(config.enabledTools, ctx);
		} catch (err) {
			ctx.ui.notify(`Atlassian MCP: auto-start failed (${(err as Error).message})`, "warning");
		}
	});

	pi.registerCommand("atlassian-tools", {
		description: "Pick Atlassian MCP tools for this session (optionally save as default)",
		handler: async (_args, ctx) => {
			let tools: McpToolDef[];
			try {
				tools = await discoverTools(ctx);
			} catch (err) {
				ctx.ui.notify(`Failed to connect to Atlassian MCP: ${(err as Error).message}`, "error");
				return;
			}
			if (tools.length === 0) {
				ctx.ui.notify("Atlassian MCP server reported no tools.", "warning");
				return;
			}

			const config = await loadConfig();
			// Start from what's live in this session; fall back to saved defaults
			// so the picker is pre-filled on first use in a fresh session.
			const selection = new Set(sessionEnabled.size > 0 ? sessionEnabled : config.enabledTools);

			const APPLY = "Apply to this session only";
			const SAVE = "Apply + save as default for new sessions";
			const CANCEL = "Cancel";

			let action: string | undefined;
			while (true) {
				const labels = tools.map(
					(t) => `${selection.has(t.name) ? "[x]" : "[ ]"} ${t.name} - ${t.description ?? ""}`.trim(),
				);
				const options = [...labels, APPLY, SAVE, CANCEL];
				const choice = await ctx.ui.select(
					`Atlassian MCP tools - ${selection.size} selected (session scope):`,
					options,
				);
				if (!choice || choice === CANCEL) return;
				if (choice === APPLY || choice === SAVE) {
					action = choice;
					break;
				}
				const idx = labels.indexOf(choice);
				if (idx < 0) continue;
				const name = tools[idx].name;
				if (selection.has(name)) selection.delete(name);
				else selection.add(name);
			}

			await activate(selection, ctx);

			if (action === SAVE) {
				await saveConfig({ ...config, autoStart: true, enabledTools: [...selection] });
				ctx.ui.notify(
					`Atlassian MCP: ${selection.size} tool(s) active and saved as default (auto-start on).`,
					"info",
				);
			} else {
				ctx.ui.notify(`Atlassian MCP: ${selection.size} tool(s) active for this session only.`, "info");
			}
		},
	});

	pi.registerCommand("atlassian-off", {
		description: "Deactivate all Atlassian MCP tools for this session",
		handler: async (_args, ctx) => {
			sessionEnabled.clear();
			syncActiveTools();
			ctx.ui.notify("Atlassian MCP tools deactivated for this session.", "info");
		},
	});

	pi.registerCommand("atlassian-autostart", {
		description: "Toggle whether saved Atlassian tools auto-load in new sessions",
		handler: async (_args, ctx) => {
			const config = await loadConfig();
			const next = !config.autoStart;
			await saveConfig({ ...config, autoStart: next });
			ctx.ui.notify(
				next
					? `Atlassian MCP auto-start ON (${config.enabledTools.length} saved tool(s) load in new sessions).`
					: "Atlassian MCP auto-start OFF - use /atlassian-tools per session.",
				"info",
			);
		},
	});

	pi.registerCommand("atlassian-reconnect", {
		description: "Force a fresh connection to the Atlassian MCP server",
		handler: async (_args, ctx) => {
			client = undefined;
			discoveredTools = [];
			try {
				await activate([...sessionEnabled], ctx);
				ctx.ui.notify("Atlassian MCP reconnected.", "info");
			} catch (err) {
				ctx.ui.notify(`Reconnect failed: ${(err as Error).message}`, "error");
			}
		},
	});
}
