/**
 * The entry point's wiring. Every file this touches is in a temporary agent
 * directory: PI_CODING_AGENT_DIR and PI_CC_CONFIG_FILE are set before the
 * extension loads, so the real ~/.pi/agent is never read or written.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-compact-index-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CC_CONFIG_FILE = path.join(agentDir, "pi-cc.json");
delete process.env.PI_CC_COMPACTION;
delete process.env.PI_CC_IDLE_COMPACTION;
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", cacheWarming: "streaming" }, null, 2));

const { fakePi, loadModule } = await import("./helpers.mjs");
const mod = await loadModule("index.ts");
const patches = await loadModule("patches.ts");
const config = await loadModule("config.ts");

const readSettings = () => JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

function ctx(notices = []) {
	return {
		mode: "rpc",
		hasUI: true,
		cwd: agentDir,
		ui: { notify: (message, level) => notices.push({ message, level }) },
		sessionManager: { getSessionId: () => "index-s", getBranch: () => [], buildSessionProjection: () => ({ entries: [], messages: [] }) },
	};
}

const host = fakePi();
mod.default(host.pi);

test("it listens where compaction, idle time and cache warming are decided, and owns /pi_cc", () => {
	assert.deepEqual([...host.handlers.keys()].sort(), [
		"agent_settled",
		"agent_start",
		"cache_warming_decision",
		"model_select",
		"session_before_compact",
		"session_compact",
		"session_shutdown",
		"session_start",
	]);
	assert.ok(host.commands.has("pi_cc"));
	assert.deepEqual(host.calls, [], "no sendMessage, tools or system prompt");
});

test("Pi's compaction settings answer with Claude Code's numbers while compaction is on", () => {
	const rt = patches.runtime();
	assert.deepEqual(rt.override({ maxTokens: 8000 }), { keepRecentTokens: 1, reserveTokens: 21000 });
	process.env.PI_CC_COMPACTION = "0";
	config.invalidateConfig();
	assert.equal(rt.override({ maxTokens: 8000 }), undefined, "off: Pi's own numbers");
	delete process.env.PI_CC_COMPACTION;
	config.invalidateConfig();
});

test("idle compaction on by default: session start turns cache warming off, /pi_cc idle off brings it back", async () => {
	const notices = [];
	await host.emit("session_start", { reason: "startup" }, ctx(notices));
	assert.equal(readSettings().cacheWarming, "off");
	assert.equal(readSettings().theme, "dark");
	assert.match(notices.at(-1).message, /cache warming off/);
	assert.deepEqual(await host.emit("cache_warming_decision", { action: "warm" }), [{ action: "stop" }]);

	await host.commands.get("pi_cc").handler("idle off", ctx(notices));
	await tick();
	assert.equal(readSettings().cacheWarming, "streaming", "exactly what it was");
	assert.deepEqual(await host.emit("cache_warming_decision", { action: "warm" }), [undefined]);

	await host.commands.get("pi_cc").handler("idle on", ctx(notices));
	await tick();
	assert.equal(readSettings().cacheWarming, "off");
});

test("with compaction off, a compaction is left to Pi", async () => {
	process.env.PI_CC_COMPACTION = "0";
	config.invalidateConfig();
	const results = await host.emit("session_before_compact", { preparation: { tokensBefore: 1 }, branchEntries: [], reason: "manual" }, { ...ctx(), model: { id: "m", api: "openai-completions" } });
	assert.deepEqual(results, [undefined]);
	delete process.env.PI_CC_COMPACTION;
	config.invalidateConfig();
});

test("session shutdown forgets the session's captured request", async () => {
	patches.runtime().captures.set("index-s", { payload: { messages: [] }, leafId: null, at: 0 });
	await host.emit("session_shutdown", {}, ctx());
	assert.equal(patches.runtime().captures.has("index-s"), false);
});
