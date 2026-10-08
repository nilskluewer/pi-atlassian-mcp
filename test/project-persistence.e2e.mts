/**
 * Pi-process smoke test for project Atlassian defaults.
 *
 * Run with `npm run test:e2e`. It is intentionally separate from `npm test`:
 * it needs a local Pi executable, but no model, network, or Atlassian account.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveConfig } from "../extensions/atlassian-mcp/index.ts";

const piBin = process.env.PI_BIN ?? "pi";
if (spawnSync(piBin, ["--version"], { stdio: "ignore" }).status !== 0) {
	console.log("SKIP project-persistence.e2e: local pi executable not available");
	process.exit(0);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectDir = await mkdtemp(join(tmpdir(), "pi-atlassian-project-e2e-"));
const cachePath = join(projectDir, "tool-cache.json");
const probePath = join(projectDir, "probe.mts");

try {
	await writeFile(
		cachePath,
		JSON.stringify({
			version: 1,
			fetchedAt: Date.now(),
			tools: [
				{
					name: "getConfluenceContent",
					description: "Get a Confluence page",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
				},
			],
		}),
		"utf8",
	);
	await writeFile(
		probePath,
		`import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.registerCommand("probe-tools", {
    handler: async (_args, ctx) => {
      writeFileSync(process.env.PROBE_OUT, JSON.stringify({
        trusted: ctx.isProjectTrusted(),
        active: pi.getActiveTools(),
      }));
      ctx.shutdown();
    },
  });
}
`,
		"utf8",
	);

await saveConfig("project", projectDir, {
	autoStart: true,
	enabledTools: ["getConfluenceContent"],
	pageScopes: [{ siteHost: "rewe.atlassian.net", rootPageId: "1657441488" }],
});
async function probe(approval: "default" | "--approve" | "--no-approve"): Promise<{ trusted: boolean; active: string[] }> {
	const outPath = join(projectDir, `probe-${approval.replace(/^--/, "")}.json`);
	const child = spawn(
		piBin,
		[
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--offline",
			...(approval === "default" ? [] : [approval]),
			"-e",
			join(repoRoot, "extensions/atlassian-mcp/index.ts"),
			"-e",
			probePath,
		],
		{
			cwd: projectDir,
			env: {
				...process.env,
				PI_ATLASSIAN_MCP_CACHE_PATH: cachePath,
				PROBE_OUT: outPath,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	child.stdin.write(JSON.stringify({ id: "probe", type: "prompt", message: "/probe-tools" }) + "\n");
	child.stdin.end();

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error(`Pi probe timed out (${approval})`));
		}, 30_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && code !== null) reject(new Error(`Pi probe exited ${code}: ${stderr}`));
			else resolve();
		});
	});
	return JSON.parse(await readFile(outPath, "utf8")) as { trusted: boolean; active: string[] };
}

const trustedFirst = await probe("default");
const trustedReopen = await probe("default");
assert.equal(trustedFirst.trusted, true);
assert.equal(trustedReopen.trusted, true);
assert.ok(trustedFirst.active.includes("atlassian_getConfluenceContent"));
assert.deepEqual(trustedReopen.active, trustedFirst.active);

const untrusted = await probe("--no-approve");
assert.equal(untrusted.trusted, false);
assert.equal(untrusted.active.includes("atlassian_getConfluenceContent"), false);

console.log("ok project persistence across fresh Pi processes");
} finally {
	await rm(projectDir, { recursive: true, force: true });
}
