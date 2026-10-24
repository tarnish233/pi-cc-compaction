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

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-compaction-index-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CC_CONFIG_FILE = path.join(agentDir, "pi-cc.json");
delete process.env.PI_CC_COMPACTION;
delete process.env.PI_CC_IDLE_COMPACTION;
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", cacheWarming: "streaming" }, null, 2));

const { fakePi, loadModule } = await import("./helpers.mjs");
const mod = await loadModule("index.ts");
const patches = await loadModule("patches.ts");
const config = await loadModule("config.ts");
const breaker = await loadModule("breaker.ts");

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

test("it listens where compaction and idle time are decided, and owns /pi_cc", () => {
	assert.deepEqual([...host.handlers.keys()].sort(), [
		"agent_settled",
		"agent_start",
		"before_provider_request",
		"model_select",
		"session_before_compact",
		"session_compact",
		"session_shutdown",
		"session_start",
		"session_tree",
		"turn_end",
	]);
	assert.ok(host.commands.has("pi_cc"));
	assert.deepEqual(host.calls, [], "no sendMessage, tools or system prompt");
});

test("a pass-through before_provider_request handler, so Pi sends every request through the runner", async () => {
	// Pi skips ExtensionRunner.emitBeforeProviderRequest, and with it the capture,
	// when no extension listens to before_provider_request.
	const payload = { model: "m", messages: [{ role: "user", content: "hi" }] };
	assert.deepEqual(await host.emit("before_provider_request", { payload }), [undefined], "returns nothing: the payload goes on unchanged");
	assert.deepEqual(payload, { model: "m", messages: [{ role: "user", content: "hi" }] });
});

test("Pi's compaction settings: Claude Code's threshold; keepRecentTokens 1 only when the fork can read the cache", () => {
	const rt = patches.runtime();
	const model = { provider: "p", id: "m", api: "openai-completions", maxTokens: 8000 };
	rt.activeSessionId = "index-s";
	patches.forgetSession("index-s");
	assert.deepEqual(rt.override(model), { reserveTokens: 21000 }, "nothing answered yet: Pi keeps what Pi keeps");
	rt.captures.set("index-s", { payload: { model: "m", messages: [] }, leafId: "l", at: Date.now() });
	assert.deepEqual(rt.override(model), { reserveTokens: 21000, keepRecentTokens: 1 });
	assert.deepEqual(rt.override({ ...model, id: "other" }), { reserveTokens: 21000 }, "another model: Pi's compaction, Pi's settings");
	breaker.reset("index-s");
	breaker.noteFailure("index-s");
	breaker.noteFailure("index-s");
	breaker.noteFailure("index-s");
	assert.deepEqual(rt.override(model), { reserveTokens: 21000, enabled: false, keepRecentTokens: 1 }, "an open breaker turns automatic compaction off");
	breaker.reset("index-s");
	process.env.PI_CC_COMPACTION = "0";
	config.invalidateConfig();
	assert.equal(rt.override(model), undefined, "off: Pi's own numbers");
	delete process.env.PI_CC_COMPACTION;
	config.invalidateConfig();
	patches.forgetSession("index-s");
});

test("a turn that got its reply makes its request the one to fork; a failed turn does not", async () => {
	const rt = patches.runtime();
	patches.forgetSession("index-s");
	const sent = { model: "m", messages: [] };
	rt.pending.set("index-s", { payload: sent, leafId: "l1", at: Date.now() });
	assert.deepEqual(await host.emit("turn_end", { message: { role: "assistant", stopReason: "error" }, toolResults: [] }, { ...ctx(), model: { id: "m" } }), [undefined]);
	assert.equal(rt.captures.has("index-s"), false, "an error reply wrote no cache");
	assert.deepEqual(await host.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [] }, { ...ctx(), model: { provider: "p", id: "m" } }), [undefined]);
	assert.equal(rt.captures.get("index-s").payload, sent);
	assert.equal(rt.captures.get("index-s").modelKey, "p/m");
	await host.emit("session_tree", {}, ctx());
	assert.equal(rt.captures.has("index-s"), false, "another branch: that prefix no longer leads here");
	rt.captures.set("index-s", { payload: sent, leafId: "l1", at: Date.now() });
	await host.emit("session_compact", { fromExtension: true, reason: "manual" }, ctx());
	assert.equal(rt.captures.has("index-s"), false, "compacted: the next request starts a new prefix");
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
	patches.runtime().pending.set("index-s", { payload: { messages: [] }, leafId: null, at: 0 });
	await host.emit("session_shutdown", {}, ctx());
	assert.equal(patches.runtime().captures.has("index-s") || patches.runtime().pending.has("index-s"), false);
});

test("a reload ends the extension, not the session: the capture and the breaker stay", async () => {
	patches.runtime().captures.set("index-s", { payload: { messages: [] }, leafId: null, at: 0 });
	patches.runtime().pending.set("index-s", { payload: { messages: [] }, leafId: null, at: 0 });
	breaker.noteFailure("index-s");
	breaker.noteFailure("index-s");
	breaker.noteFailure("index-s");
	await host.emit("session_shutdown", { reason: "reload" }, ctx());
	assert.equal(patches.runtime().captures.has("index-s"), true, "the last answered request is still the one to fork");
	assert.equal(patches.runtime().pending.has("index-s"), true, "a request still in flight still gets its reply");
	assert.equal(breaker.isOpen("index-s"), true, "the session's failures still count");
	patches.forgetSession("index-s");
	breaker.reset("index-s");
});

test("a reload re-arms the idle compaction: no run will settle to do it", async () => {
	patches.runtime().captures.set("index-s", { payload: { messages: [] }, leafId: null, at: Date.now() });
	const idleChecks = [];
	const idleCtx = {
		...ctx(),
		model: { id: "m", promptCache: { short: 7200, long: 7200 } },
		isIdle: () => (idleChecks.push(1), true),
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens: 250000 }),
	};
	await host.emit("agent_settled", {}, idleCtx);
	await tick();
	const armed = idleChecks.length;
	assert.ok(armed >= 1, "a settled run armed the idle compaction");
	await host.emit("session_shutdown", { reason: "reload" }, idleCtx);
	await host.emit("session_start", { reason: "reload" }, idleCtx);
	await tick();
	assert.ok(idleChecks.length > armed, "the reload's session_start re-armed it");
	await host.emit("session_shutdown", {}, ctx());
	patches.forgetSession("index-s");
});
