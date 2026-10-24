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

test("the final provider payload is captured per session, after every extension ran", async () => {
	const classes = fakeClasses();
	patches.installPatches(classes);
	const rt = patches.runtime();
	const runner = new classes.ExtensionRunner("s1", "leaf-7");
	const sent = await runner.emitBeforeProviderRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
	assert.equal(sent.user, "added later", "the payload itself is passed through");
	const capture = rt.captures.get("s1");
	assert.deepEqual(capture.payload, sent);
	assert.notEqual(capture.payload, sent, "a copy: later mutation of the request cannot change it");
	assert.equal(capture.leafId, "leaf-7");
	assert.ok(Math.abs(capture.at - Date.now()) < 1000);
	await new classes.ExtensionRunner("s2", "x").emitBeforeProviderRequest({ model: "m", input: [{ role: "user", content: [] }] });
	assert.ok(rt.captures.has("s2"), "responses-style input is a conversation too");
});

test("cache-warming replays and payloads without a conversation are not captured", async () => {
	const classes = fakeClasses();
	patches.installPatches(classes);
	const rt = patches.runtime();
	const runner = new classes.ExtensionRunner("s3", "leaf-1");
	await runner.emitBeforeProviderRequest({ model: "m", messages: [{ role: "user", content: "real" }], max_tokens: 4096 });
	for (const replay of [{ max_tokens: 1 }, { max_completion_tokens: 1 }, { max_output_tokens: 1 }]) {
		await new classes.ExtensionRunner("s3", "leaf-2").emitBeforeProviderRequest({ model: "m", messages: [{ role: "user", content: "warm" }], ...replay });
	}
	await new classes.ExtensionRunner("s3", "leaf-3").emitBeforeProviderRequest({ model: "m" });
	assert.equal(rt.captures.get("s3").payload.messages[0].content, "real");
	assert.equal(rt.captures.get("s3").leafId, "leaf-1");
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
