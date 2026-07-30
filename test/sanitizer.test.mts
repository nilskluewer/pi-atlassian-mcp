/**
 * Offline tests for the untrusted-input hardening.
 * Run: npm test
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inheritedToolNames,
	loadEffectiveConfig,
	sanitizeInputSchema,
	sanitizeText,
	saveConfig,
	TOOL_NAME_PATTERN,
} from "../extensions/atlassian-mcp/index.ts";

let passed = 0;
function check(name: string, fn: () => void) {
	fn();
	passed++;
	console.log(`  ok  ${name}`);
}

console.log("sanitizeInputSchema");
check("strips prototype-polluting keys but keeps siblings", () => {
	const raw = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"string"}}}');
	const props = sanitizeInputSchema(raw)!.properties as Record<string, unknown>;
	assert.ok(!Object.keys(props).includes("__proto__"));
	assert.ok(Object.keys(props).includes("ok"));
});
check("rejects schemas that are not top-level objects", () => {
	assert.equal(sanitizeInputSchema({ type: "string" }), undefined);
	assert.equal(sanitizeInputSchema(null), undefined);
	assert.equal(sanitizeInputSchema([1, 2]), undefined);
	assert.equal(sanitizeInputSchema("nope"), undefined);
});
check("rejects a non-object properties map", () => {
	assert.equal(sanitizeInputSchema({ type: "object", properties: [] }), undefined);
});
check("synthesizes a missing properties map", () => {
	assert.deepEqual(sanitizeInputSchema({ type: "object" })!.properties, {});
});
check("survives pathologically deep schemas", () => {
	let deep: unknown = { type: "string" };
	for (let i = 0; i < 40; i++) deep = { type: "object", properties: { n: deep } };
	assert.notEqual(sanitizeInputSchema(deep), undefined);
});

console.log("sanitizeText");
check("strips control characters", () => {
	assert.equal(sanitizeText("a\u0007b\u0000c", 100), "a b c");
});
check("truncates to the limit", () => {
	assert.equal(sanitizeText("x".repeat(50), 10)!.length, 10);
});
check("returns undefined for empty or non-string input", () => {
	assert.equal(sanitizeText("   ", 10), undefined);
	assert.equal(sanitizeText(undefined, 10), undefined);
	assert.equal(sanitizeText(42, 10), undefined);
});

console.log("TOOL_NAME_PATTERN");
check("accepts real Atlassian tool names", () => {
	for (const n of ["getConfluencePage", "atlassianUserInfo", "getAccessibleAtlassianResources"]) {
		assert.ok(TOOL_NAME_PATTERN.test(n), n);
	}
});
check("rejects names that could break out of the namespace", () => {
	for (const n of ["../evil", "read", "a b", "", "x".repeat(65), "tool;rm"]) {
		if (n === "read") continue; // valid shape; collision is caught separately at registration
		assert.ok(!TOOL_NAME_PATTERN.test(n), n);
	}
});

console.log("subagent tool inheritance");
check("takes only well-formed atlassian_ entries from the parent tool set", () => {
	process.env.PI_SUBAGENT_INHERITED_TOOLS =
		"read,bash,atlassian_getConfluencePage,atlassian_search,atlassian_getConfluencePage,web_search";
	assert.deepEqual(inheritedToolNames(), ["getConfluencePage", "search"]);
});
check("refuses inherited names that are not valid MCP tool names", () => {
	process.env.PI_SUBAGENT_INHERITED_TOOLS = "atlassian_../evil,atlassian_,atlassian_ok";
	assert.deepEqual(inheritedToolNames(), ["ok"]);
});
check("no env means nothing is inherited", () => {
	delete process.env.PI_SUBAGENT_INHERITED_TOOLS;
	assert.deepEqual(inheritedToolNames(), []);
});

console.log("project configuration");
const projectDir = await mkdtemp(join(tmpdir(), "pi-atlassian-mcp-test-"));
try {
	await saveConfig("project", projectDir, {
		autoStart: true,
		enabledTools: ["getConfluencePage"],
	});
	const effective = await loadEffectiveConfig(projectDir, true);
	assert.deepEqual(effective, {
		scope: "project",
		config: { autoStart: true, enabledTools: ["getConfluencePage"] },
	});
	passed++;
	console.log("  ok  trusted project configuration overrides global defaults");
} finally {
	await rm(projectDir, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
