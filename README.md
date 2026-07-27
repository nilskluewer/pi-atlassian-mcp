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

Requires `npx` on PATH.
The extension spawns [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) to reach the remote server, which handles the OAuth 2.1 + PKCE flow and caches tokens for you.
A browser window opens on first use.

## Usage

| Command | Scope | What it does |
|---|---|---|
| `/atlassian-tools` | session | Connect, list every available tool, toggle the ones you want |
| `/atlassian-off` | session | Deactivate all Atlassian tools immediately |
| `/atlassian-autostart` | global | Toggle whether saved defaults load in new sessions |
| `/atlassian-reconnect` | session | Drop the cached connection and reconnect, e.g. after re-auth |

In `/atlassian-tools`, toggle tools with `[x]` / `[ ]`, then choose:

- **Apply to this session only** - active now, nothing written to disk, next session starts clean.
- **Apply + save as default for new sessions** - also persists the selection and enables auto-start.
- **Cancel** - changes nothing.

The picker pre-fills from what is live in the session, falling back to your saved default, so you can start from your usual set and trim it for one session.

## Configuration

`~/.pi/agent/atlassian-mcp.json`, written only when you explicitly save:

```json
{
  "autoStart": false,
  "enabledTools": ["getConfluencePage", "getJiraIssue"]
}
```

- `autoStart` (default `false`) - apply the saved selection on `session_start`.
  While `false`, no MCP connection is made at startup at all.
- `enabledTools` - raw MCP tool names, without the `atlassian_` prefix.

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
pi -e .
```

For local development against your own Pi install, symlink the directory extension instead of copying it, so there is exactly one real copy on disk:

```bash
ln -s "$PWD/extensions/atlassian-mcp" ~/.pi/agent/extensions/atlassian-mcp
```

Run `/reload` in Pi after changing the source.

## License

MIT
