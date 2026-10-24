import assert from "node:assert";
import test from "node:test";
import { loadModule, loadPi } from "./helpers.mjs";

const patches = await loadModule("patches.ts");

function fakeClasses() {
	class Settings {
		getCompactionSettings(_model) {
			return { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
		}
	}
	class Runner {
		constructor(sessionId, leafId) {
			this.sessionManager = { getSessionId: () => sessionId, getLeafId: () => leafId };
		}
		async emitBeforeProviderRequest(payload) {
			// An extension loaded after pi-cc-compact still changes the payload.
			return { ...payload, user: "added later" };
		}
	}
	return { SettingsManager: Settings, ExtensionRunner: Runner };
}

test("Claude Code's reserve: min(output cap, 20K) plus 13K", () => {
	assert.equal(patches.ccReserveTokens({ maxTokens: 128000 }), 33000);
	assert.equal(patches.ccReserveTokens({ maxTokens: 8000 }), 21000);
	assert.equal(patches.ccReserveTokens({}), 33000);
	assert.equal(patches.ccReserveTokens(undefined), 33000);
});

test("getCompactionSettings answers with the override, and remembers Pi's settings object", () => {
	const classes = fakeClasses();
	assert.deepEqual(patches.installPatches(classes).missing, []);
	const rt = patches.runtime();
	const settings = new classes.SettingsManager();
	rt.override = undefined;
	assert.deepEqual(settings.getCompactionSettings({ provider: "p", id: "m" }), { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
	assert.equal(rt.settings, settings, "Pi's live settings object, for cacheWarming");
	rt.override = (model) => ({ keepRecentTokens: 1, reserveTokens: patches.ccReserveTokens(model) });
	assert.deepEqual(settings.getCompactionSettings({ provider: "p", id: "m", maxTokens: 8000 }), {
		enabled: true,
		reserveTokens: 21000,
		keepRecentTokens: 1,
	});
	rt.override = () => undefined;
	assert.deepEqual(settings.getCompactionSettings({}), { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
});

test("the final provider payload is held per session as the request in flight, by reference", async () => {
	const classes = fakeClasses();
	patches.installPatches(classes);
	const rt = patches.runtime();
	const runner = new classes.ExtensionRunner("s1", "leaf-7");
	const sent = await runner.emitBeforeProviderRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
	assert.equal(sent.user, "added later", "the payload itself is passed through");
	const pending = rt.pending.get("s1");
	assert.equal(pending.payload, sent, "the very object Pi sends: no copy");
	assert.equal(pending.leafId, "leaf-7");
	assert.ok(Math.abs(pending.at - Date.now()) < 1000);
	assert.equal(rt.captures.has("s1"), false, "not usable before its reply arrives");
	await new classes.ExtensionRunner("s2", "x").emitBeforeProviderRequest({ model: "m", input: [{ role: "user", content: [] }] });
	assert.ok(rt.pending.has("s2"), "responses-style input is a conversation too");
});

test("a successful reply makes the request in flight the one to fork; a failed one leaves the last success", async () => {
	const classes = fakeClasses();
	patches.installPatches(classes);
	const rt = patches.runtime();
	await new classes.ExtensionRunner("s4", "leaf-1").emitBeforeProviderRequest({ model: "m", messages: [{ role: "user", content: "one" }] });
	assert.equal(patches.commitPending("s4", { modelKey: "p/m", ttlMs: 3600_000 }), true);
	assert.equal(rt.captures.get("s4").leafId, "leaf-1");
	assert.equal(rt.captures.get("s4").ttlMs, 3600_000);
	assert.equal(rt.captures.get("s4").modelKey, "p/m", "the provider and model the reply came from");
	assert.equal(rt.pending.has("s4"), false);
	// The next request overflows: it is in flight, never committed.
	await new classes.ExtensionRunner("s4", "leaf-2").emitBeforeProviderRequest({ model: "m", messages: [{ role: "user", content: "two" }] });
	assert.equal(rt.captures.get("s4").leafId, "leaf-1", "the request that succeeded is still the one to fork");
	assert.equal(patches.commitPending("s5"), false, "nothing in flight, nothing to commit");
	patches.forgetSession("s4");
	assert.equal(rt.captures.has("s4") || rt.pending.has("s4"), false);
});

test("cache-warming replays and payloads without a conversation are not held", async () => {
	const classes = fakeClasses();
	patches.installPatches(classes);
	const rt = patches.runtime();
	const runner = new classes.ExtensionRunner("s3", "leaf-1");
	await runner.emitBeforeProviderRequest({ model: "m", messages: [{ role: "user", content: "real" }], max_tokens: 4096 });
	for (const replay of [{ max_tokens: 1 }, { max_completion_tokens: 1 }, { max_output_tokens: 1 }]) {
		await new classes.ExtensionRunner("s3", "leaf-2").emitBeforeProviderRequest({ model: "m", messages: [{ role: "user", content: "warm" }], ...replay });
	}
	await new classes.ExtensionRunner("s3", "leaf-3").emitBeforeProviderRequest({ model: "m" });
	assert.equal(rt.pending.get("s3").payload.messages[0].content, "real");
	assert.equal(rt.pending.get("s3").leafId, "leaf-1");
	assert.equal(patches.isWarmReplay({ max_tokens: 1 }), true);
	assert.equal(patches.isWarmReplay({ max_tokens: 2 }), false);
});

test("installing twice (a /reload) wraps once", async () => {
	const classes = fakeClasses();
	patches.installPatches(classes);
	const first = classes.ExtensionRunner.prototype.emitBeforeProviderRequest;
	const firstSettings = classes.SettingsManager.prototype.getCompactionSettings;
	patches.installPatches(classes);
	assert.equal(classes.ExtensionRunner.prototype.emitBeforeProviderRequest, first);
	assert.equal(classes.SettingsManager.prototype.getCompactionSettings, firstSettings);
});

test("a Pi without the methods is reported, not patched", () => {
	const result = patches.installPatches({ SettingsManager: class {}, ExtensionRunner: undefined });
	assert.deepEqual(result.missing, ["SettingsManager.getCompactionSettings", "ExtensionRunner.emitBeforeProviderRequest"]);
});

test("Pi's own classes have the methods (Pi " + "under test)", async () => {
	const { agent, version } = await loadPi();
	assert.equal(typeof agent.SettingsManager?.prototype?.getCompactionSettings, "function", `SettingsManager in Pi ${version}`);
	assert.equal(typeof agent.ExtensionRunner?.prototype?.emitBeforeProviderRequest, "function", `ExtensionRunner in Pi ${version}`);
	assert.deepEqual(patches.installPatches({ SettingsManager: agent.SettingsManager, ExtensionRunner: agent.ExtensionRunner }).missing, []);
	const settings = agent.SettingsManager.inMemory?.({}) ?? agent.SettingsManager.create(process.cwd());
	patches.runtime().override = () => ({ keepRecentTokens: 1, reserveTokens: 33000 });
	const answered = settings.getCompactionSettings({ provider: "p", id: "m" });
	assert.equal(answered.keepRecentTokens, 1);
	assert.equal(answered.reserveTokens, 33000);
	assert.equal(patches.runtime().settings, settings);
});
