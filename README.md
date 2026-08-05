# pi-atlassian-mcp

Bridge the [Atlassian Rovo MCP server](https://github.com/atlassian/atlassian-mcp-server) (Jira, Confluence, Compass, Bitbucket) into [Pi](https://pi.dev), with **per-session, opt-in tool selection**.

Pi deliberately ships without built-in MCP support.
This extension adds it for one specific server, and adds the thing a generic MCP client usually lacks: precise control over *which* tools are exposed and *when*.

## Why tool selection matters

The Rovo server exposes a lot of tools.
Every active tool costs context window on every single request, whether or not you touch Jira that day.

This extension therefore activates **nothing** by default.
You opt in per session, and can optionally save a default set.

## Install

```bash
pi install npm:@nilskluewer/pi-atlassian-mcp
```

The extension spawns [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) to reach the remote server, which handles the OAuth 2.1 + PKCE flow and caches tokens for you.
A browser window opens on first use.

`mcp-remote` is an **exact dependency** invoked through its locally installed binary, not an unpinned `npx -y` fetch, so the executed version is fixed by this package's published dependency manifest rather than resolved from the registry at runtime.

## Trust model

The MCP server is a remote third party, so everything it returns is treated as untrusted input:

- **Tool names** are validated against `^[A-Za-z0-9_-]{1,64}$` and refused if they would collide with an existing Pi tool, so a server cannot shadow a built-in such as `read` or `bash`.
- **Input schemas** are deep-cloned with prototype-polluting keys (`__proto__`, `constructor`, `prototype`) removed and depth/size bounds applied. A schema that is not a top-level object schema is refused and its tool is skipped rather than registered.
- **Descriptions** are stripped of control characters and truncated before they reach the system prompt.
- **Tool results** are fenced with an explicit untrusted-data notice, because Confluence and Jira content is attacker-influencable and would otherwise read to the model like instructions.

This hardening is a safety net, not a functional restriction: all 31 tools currently exposed by the Atlassian server pass unchanged, with no schema altered.

It does **not** make prompt injection impossible. Anyone who can edit a page you fetch can put text in front of the model. Treat Atlassian content as you would any untrusted web page.

## Usage

| Command | Scope | What it does |
|---|---|---|
| `/atlassian-tools` | session, global, or project | Connect, list every available tool, toggle the ones you want, and optionally save the selection |
| `/atlassian-off` | session | Deactivate all Atlassian tools immediately |
| `/atlassian-autostart [global\|project]` | global or project | Toggle whether the selected scope's saved tools load in new sessions |
| `/atlassian-reconnect` | session | Drop the cached connection and reconnect, e.g. after re-auth |

`/atlassian-tools` opens a checkbox list:

| Key | Action |
|---|---|
| `↑` / `↓` | Move, wrapping around at both ends |
| `space` or `enter` | Toggle the highlighted tool |
| `a` | Select all / none |
| `enter` on a `▸` row | Apply the selection |
| `esc` | Cancel, changing nothing |

The `▸` rows decide what happens to the selection:

- **Apply to this session** - active now, nothing written to disk, next session starts clean.
- **Save as global default** - persists the selection in your user configuration for every project without a project override, and loads it automatically in new sessions.
- **Save as project default** - the same for the current project's configuration.
  This choice is available only for trusted projects.

Saving turns `autoStart` on: a saved default that does not load is not a default.
Use `/atlassian-autostart` if you want a saved selection to stay dormant.

The picker pre-fills from what is live in the session, falling back to the effective saved default, so you can start from your usual set and trim it for one session.

## Subagents

A subagent runs as a separate Pi process with no UI, so it can never open the picker.
When [pi-subagent](https://github.com/nilskluewer/pi-subagent) spawns a child, it publishes the parent's tool set in `PI_SUBAGENT_INHERITED_TOOLS`; this extension activates the `atlassian_*` names it finds there.
A subagent therefore starts with exactly the Atlassian tools the main agent had, and narrowing a subagent's `tools` allowlist narrows the inherited set too.

Inherited and auto-started selections are registered from a local cache of tool definitions, so neither costs a connection at startup - the MCP server is contacted on the first actual tool call.

## Configuration

The global default is `~/.pi/agent/atlassian-mcp.json`.
A trusted project can override it in `.pi/atlassian-mcp.json` at the project root.
Project configuration is ignored until Pi trusts the project, and when present it fully overrides the global configuration for that project.

Both files use the same shape and are written only when you explicitly save:

```json
{
  "autoStart": true,
  "enabledTools": ["getConfluencePage", "getJiraIssue"]
}
```

- `autoStart` (default `false`, set to `true` when you save from the picker) - apply the saved selection on `session_start`.
  Startup never connects: tools are registered from the cache described below.
- `enabledTools` - raw MCP tool names, without the `atlassian_` prefix.

`~/.pi/agent/atlassian-mcp.cache.json` holds the tool definitions from the last successful discovery.
It is written automatically, refreshed whenever the picker or `/atlassian-reconnect` talks to the server, ignored after seven days, and safe to delete.

Use `/atlassian-autostart` to toggle the effective scope.
Use `/atlassian-autostart global` or `/atlassian-autostart project` to change a specific scope.

Tools are exposed to the model as `atlassian_<mcpToolName>`, for example `atlassian_getConfluencePage`.

## Tool hints

Some MCP tools have quirks their own descriptions do not mention.
`TOOL_GUIDELINES` in `extensions/atlassian-mcp/index.ts` attaches extra guidance to individual tools via Pi's `promptGuidelines`, which is injected into the system prompt **only while that tool is active** - so unused hints cost nothing.

Shipped hints, both learned the hard way:

- **`getConfluencePage`** - if the body comes back empty, retry with `contentFormat: "html"`.
  Pages built from macros (such as Aura panels) render as blank in markdown while the HTML carries the real content, headlines, and links.
  If the body turns out to be only tiles and links, treat the page as a navigation hub and call `getConfluencePageDescendants`.
- **`getConfluencePageDescendants`** - check each entry's `status` and flag drafts, especially drafts whose title duplicates a published sibling.

To add your own, add an entry keyed by the raw MCP tool name.

## Development

```bash
git clone git@github.com:nilskluewer/pi-atlassian-mcp.git
cd pi-atlassian-mcp
npm install
npm test
pi -e .
```

`npm test` runs offline unit tests for the untrusted-input hardening. No network or Atlassian account required.

For local development against your own Pi install, symlink the directory extension instead of copying it, so there is exactly one real copy on disk:

```bash
ln -s "$PWD/extensions/atlassian-mcp" ~/.pi/agent/extensions/atlassian-mcp
ln -sfn ../../node_modules "$PWD/extensions/atlassian-mcp/node_modules"
```

The second symlink is required. Pi's loader resolves modules by walking up from the
*symlink* path (`~/.pi/agent/extensions/...`), not from the real repo path, so it never
reaches this repo's root `node_modules` and `@modelcontextprotocol/sdk` fails to resolve.
A failed extension load aborts Pi startup entirely, so getting this wrong breaks every new
session. This affects local symlink development only - an npm-installed copy resolves
normally.

Verify through the symlink, from an unrelated directory, not just with `pi -e .` inside
the repo (which resolves deps the real install path cannot see):

```bash
cd /tmp && pi -p "say hi"
```

Run `/reload` in Pi after changing the source.

## License

MIT
