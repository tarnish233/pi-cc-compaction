import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule, loadPi } from "./helpers.mjs";

const warming = await loadModule("warming.ts");
const { agent } = await loadPi();

const ON = { compaction: true, idleCompaction: true };
const OFF = { compaction: true, idleCompaction: false };

function setup(settings, piCc = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-compact-warming-"));
	const agentDir = path.join(dir, "agent");
	fs.mkdirSync(agentDir);
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
	const configFile = path.join(agentDir, "pi-cc.json");
	fs.writeFileSync(configFile, JSON.stringify(piCc, null, 2));
	const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
	return {
		deps: { agentDir, configFile, create: () => agent.SettingsManager.create(dir, agentDir) },
		settings: () => read(path.join(agentDir, "settings.json")),
		piCc: () => read(configFile),
	};
}

test("idle compaction on: cacheWarming goes off, and what it was is remembered", async () => {
	const s = setup({ theme: "dark", cacheWarming: "streaming" }, { footer: true });
	assert.equal(await warming.syncCacheWarming(ON, s.deps), "disabled");
	assert.deepEqual(s.settings(), { theme: "dark", cacheWarming: "off" }, "only that key changes");
	assert.deepEqual(s.piCc(), { footer: true, [warming.SAVED_KEY]: "streaming" });
	assert.equal(await warming.syncCacheWarming(ON, s.deps), "unchanged", "already off: nothing to do");
	assert.equal(s.piCc()[warming.SAVED_KEY], "streaming", "the original is not overwritten by off");
});

test("a setting that was never written is remembered as absent", async () => {
	const s = setup({ theme: "dark" });
	assert.equal(await warming.syncCacheWarming(ON, s.deps), "disabled");
	assert.equal(s.settings().cacheWarming, "off");
	assert.equal(s.piCc()[warming.SAVED_KEY], null);
});

test("cacheWarming already off is left alone and nothing is remembered", async () => {
	const s = setup({ cacheWarming: "off" });
	assert.equal(await warming.syncCacheWarming(ON, s.deps), "unchanged");
	assert.ok(!(warming.SAVED_KEY in s.piCc()));
	assert.equal(await warming.syncCacheWarming(OFF, s.deps), "unchanged", "nothing to restore");
	assert.equal(s.settings().cacheWarming, "off");
});

test("idle compaction off: the remembered value comes back exactly", async () => {
	const explicit = setup({ theme: "dark", cacheWarming: "off" }, { footer: false, [warming.SAVED_KEY]: "streaming" });
	assert.equal(await warming.syncCacheWarming(OFF, explicit.deps), "restored");
	assert.deepEqual(explicit.settings(), { theme: "dark", cacheWarming: "streaming" });
	assert.deepEqual(explicit.piCc(), { footer: false }, "the memo is removed, the rest stays");

	const absent = setup({ theme: "dark", cacheWarming: "off" }, { [warming.SAVED_KEY]: null });
	assert.equal(await warming.syncCacheWarming(OFF, absent.deps), "restored");
	assert.deepEqual(absent.settings(), { theme: "dark" }, "absent again: Pi's default applies");
});

test("a value the user changed meanwhile is theirs: only the memo goes", async () => {
	const s = setup({ cacheWarming: "idle" }, { [warming.SAVED_KEY]: "streaming" });
	assert.equal(await warming.syncCacheWarming(OFF, s.deps), "unchanged");
	assert.equal(s.settings().cacheWarming, "idle");
	assert.ok(!(warming.SAVED_KEY in s.piCc()));
});

test("Pi's live settings object is used when there is one, so memory changes too", async () => {
	const s = setup({ cacheWarming: "streaming" });
	const calls = [];
	const live = {
		getCacheWarmingMode: () => "streaming",
		setCacheWarmingMode: (mode) => calls.push(["set", mode]),
		flush: async () => calls.push(["flush"]),
	};
	assert.equal(await warming.syncCacheWarming(ON, { ...s.deps, live, create: () => assert.fail("not created") }), "disabled");
	assert.deepEqual(calls, [["set", "off"], ["flush"]]);
});

test("the live object is brought in line with a file someone else set off", async () => {
	const s = setup({ cacheWarming: "off" }, { [warming.SAVED_KEY]: "streaming" });
	const calls = [];
	const live = { getCacheWarmingMode: () => "streaming", setCacheWarmingMode: (mode) => calls.push(mode), flush: async () => {} };
	assert.equal(await warming.syncCacheWarming(ON, { ...s.deps, live }), "unchanged");
	assert.deepEqual(calls, ["off"]);
});

test("warming is blocked exactly while idle compaction is in effect", () => {
	assert.equal(warming.warmingBlocked(ON), true);
	assert.equal(warming.warmingBlocked(OFF), false);
	assert.equal(warming.warmingBlocked({ compaction: false, idleCompaction: true }), false, "idle compaction needs Claude Code's compaction");
});
