import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import atlassianMcpExtension from "../extensions/atlassian-mcp/index.ts";

const forwarded = [
	"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
	"NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];
const savedEnv = { ...process.env };
const originalStart = StdioClientTransport.prototype.start;
let captured: { args: string[]; env: Record<string, string> } | undefined;
// Capture the actual transport options without spawning a child or contacting Atlassian.
StdioClientTransport.prototype.start = async function () {
	captured = (this as unknown as { _serverParams: typeof captured })._serverParams;
	throw new Error("offline proxy check");
};

try {
	for (const proxy of [undefined, "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
		for (const name of forwarded) delete process.env[name];
		if (proxy) process.env[proxy] = "http://127.0.0.1:8080";
		process.env.NO_PROXY = "localhost,127.0.0.1";
		process.env.no_proxy = "example.test";
		process.env.NODE_EXTRA_CA_CERTS = "/tmp/proxy-ca.pem";
		process.env.SSL_CERT_FILE = "/tmp/proxy-ca.pem";
		process.env.PROXY_TEST_SECRET = "must not reach child";

		let connect: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		atlassianMcpExtension({
			on() {},
			registerCommand(name: string, command: { handler: typeof connect }) {
				if (name === "atlassian-tools") connect = command.handler;
			},
		} as unknown as ExtensionAPI);
		assert.ok(connect);
		captured = undefined;
		await connect("", {
			hasUI: true,
			cwd: process.cwd(),
			isProjectTrusted: () => false,
			ui: { notify() {} },
		});
		assert.ok(captured, "must reach the stdio transport");
		const options = captured as { args: string[]; env: Record<string, string> };
		assert.equal(options.args.includes("--enable-proxy"), Boolean(proxy));
		assert.equal(options.args[1], "https://mcp.atlassian.com/v2/mcp?tools=all");
		for (const name of forwarded) assert.equal(options.env[name], process.env[name], name);
		assert.equal(options.env.PROXY_TEST_SECRET, undefined);
		assert.equal(options.env.HOME, process.env.HOME);
		console.log(`ok proxy environment: ${proxy ?? "no proxy"}`);
	}
} finally {
	StdioClientTransport.prototype.start = originalStart;
	for (const name of [...forwarded, "PROXY_TEST_SECRET"]) {
		if (savedEnv[name] === undefined) delete process.env[name];
		else process.env[name] = savedEnv[name];
	}
}
