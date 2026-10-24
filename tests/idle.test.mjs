import assert from "node:assert";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const idle = await loadModule("idle.ts");
const patches = await loadModule("patches.ts");

const ON = { compaction: true, idleCompaction: true };
const HOUR = 3600_000;

test("the cache lifetime comes from the model's promptCache, for the retention Pi uses", () => {
	const model = { promptCache: { short: 300, long: 3600 } };
	assert.equal(idle.ttlForTier(model, "short"), 300_000);
	assert.equal(idle.ttlForTier(model, "long"), 3600_000);
	assert.equal(idle.ttlForTier({ promptCache: { short: 300 } }, "long"), undefined);
	assert.equal(idle.ttlForTier({}, "short"), undefined, "no promptCache, no idle compaction");
});

test("it fires at 90% of the lifetime, as Claude Code and Pi's warmer do", () => {
	assert.equal(idle.idleDelayMs(HOUR), 3240_000);
	assert.equal(idle.idleDelayMs(60_000), 50_000, "ten seconds of margin at least");
	assert.equal(idle.idleMinTokens({}), 200_000);
	assert.equal(idle.idleMinTokens({ PI_CC_IDLE_COMPACT_MIN_TOKENS: "150000" }), 150_000);
	assert.equal(idle.idleMinTokens({ PI_CC_IDLE_COMPACT_MIN_TOKENS: "5000" }), 100_000, "not below Claude Code's floor");
});

function harness({ now = 1_000_000, tokens = 250_000, ttl = { long: 3600 }, idleNow = true, pending = false, env = { PI_CACHE_RETENTION: "long" }, auth } = {}) {
	const clock = { now };
	const timers = [];
	const compacts = [];
	const notices = [];
	const ctx = {
		model: { provider: "p", id: "m", promptCache: ttl },
		hasUI: true,
		ui: { notify: (message, level) => notices.push({ message, level }) },
		isIdle: () => idleNow,
		hasPendingMessages: () => pending,
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
		sessionManager: { getSessionId: () => "idle-s" },
		compact: (options) => compacts.push(options),
		modelRegistry: { getApiKeyAndHeaders: async () => (auth instanceof Error ? Promise.reject(auth) : (auth ?? { ok: true })) },
	};
	const compactor = new idle.IdleCompactor({
		now: () => clock.now,
		env,
		setTimer: (fn, ms) => {
			const timer = { fn, ms, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (timer) => {
			timer.cleared = true;
		},
	});
	return { clock, timers, compacts, notices, ctx, compactor };
}

test("armed after a settled run: due at the last request plus 90% of an hour", async () => {
	const h = harness();
	patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now - 60_000 });
	await h.compactor.arm(h.ctx, ON);
	assert.equal(h.timers.length, 1);
	assert.equal(h.timers[0].ms, 3240_000 - 60_000);
	h.clock.now += h.timers[0].ms;
	h.timers[0].fn();
	assert.equal(h.compacts.length, 1, "compacts through Pi, so the fork reads the still-warm cache");
	h.compacts[0].onComplete({});
	assert.deepEqual(h.notices.at(-1), { message: "Compacted while idle, before the prompt cache expired \u00b7 turn off with /pi_cc idle off", level: "info" });
});

test("not armed: settings off, short or unknown cache, small context, busy session, nothing captured", async () => {
	const cases = [
		["compaction off", {}, { compaction: false, idleCompaction: true }],
		["idle off", {}, { compaction: true, idleCompaction: false }],
		["five-minute cache", { ttl: { short: 300, long: 300 } }, ON],
		["short retention", { env: {} , ttl: { short: 300, long: 3600 } }, ON],
		["no promptCache", { ttl: null }, ON],
		["small context", { tokens: 199_999 }, ON],
		["busy", { idleNow: false }, ON],
		["queued messages", { pending: true }, ON],
	];
	for (const [label, options, config] of cases) {
		const h = harness(options);
		patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now });
		await h.compactor.arm(h.ctx, config);
		assert.equal(h.timers.length, 0, label);
	}
	const h = harness();
	patches.runtime().captures.delete("idle-s");
	await h.compactor.arm(h.ctx, ON);
	assert.equal(h.timers.length, 0, "no request yet: no cache to keep");
});

test("when it fires it checks again: a newer request, a busy session or a lapsed timer skip it", async () => {
	for (const [label, change] of [
		["newer request", (h) => patches.runtime().captures.set("idle-s", { payload: {}, leafId: "y", at: h.clock.now })],
		["busy", (h) => (h.ctx.isIdle = () => false)],
		["lapsed", (h) => (h.clock.now += 61_000)],
		["context shrank", (h) => (h.ctx.getContextUsage = () => ({ tokens: 10, contextWindow: 1 }))],
	]) {
		const h = harness();
		patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now });
		await h.compactor.arm(h.ctx, ON);
		h.clock.now += h.timers[0].ms;
		change(h);
		h.timers[0].fn();
		assert.equal(h.compacts.length, 0, label);
	}
});

test("re-arming or cancelling clears the timer; a failed compaction is reported once", async () => {
	const h = harness();
	patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now });
	await h.compactor.arm(h.ctx, ON);
	await h.compactor.arm(h.ctx, ON);
	assert.equal(h.timers[0].cleared, true);
	h.compactor.cancel();
	assert.equal(h.timers[1].cleared, true);
	await h.compactor.arm(h.ctx, ON);
	h.clock.now += h.timers[2].ms;
	h.timers[2].fn();
	h.compacts[0].onError(new Error("Compaction cancelled"));
	// ctx.compact is a manual compaction as far as compact.ts knows: it already
	// showed the failure; the idle pass says nothing more.
	assert.deepEqual(h.notices, []);
	h.compacts[0].onError(new Error("boom"));
	assert.deepEqual(h.notices, [{ message: "Idle compaction failed: boom", level: "warning" }]);
});

test("a provider's own PI_CACHE_RETENTION (the env of its auth.json entry) picks the long tier, as Pi's requests do", async () => {
	const h = harness({ env: {}, ttl: { short: 300, long: 3600 }, auth: { ok: true, env: { PI_CACHE_RETENTION: "long" } } });
	patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now });
	await h.compactor.arm(h.ctx, ON);
	assert.equal(h.timers.length, 1);
	assert.equal(h.timers[0].ms, 3240_000);
	assert.equal(await idle.cacheRetentionTier(h.ctx, {}), "long");
});

test("the provider's value wins over the process environment, as in Pi", async () => {
	const h = harness({ env: { PI_CACHE_RETENTION: "long" }, ttl: { short: 300, long: 3600 }, auth: { ok: true, env: { PI_CACHE_RETENTION: "short" } } });
	patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now });
	await h.compactor.arm(h.ctx, ON);
	assert.equal(h.timers.length, 0, "the provider says short: a five-minute cache");
});

test("without the provider's environment, the process environment decides", async () => {
	for (const auth of [new Error("no key"), { ok: false, error: "no key" }, { ok: true }]) {
		const h = harness({ env: { PI_CACHE_RETENTION: "long" }, ttl: { short: 300, long: 3600 }, auth });
		patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now });
		await h.compactor.arm(h.ctx, ON);
		assert.equal(h.timers.length, 1, String(auth?.message ?? auth?.error ?? "no env"));
	}
});

test("a cancel while the provider is looked up wins", async () => {
	let release;
	const h = harness({ env: {}, ttl: { long: 3600 } });
	h.ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise((resolve) => (release = resolve));
	patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now });
	const armed = h.compactor.arm(h.ctx, ON);
	h.compactor.cancel();
	release({ ok: true, env: { PI_CACHE_RETENTION: "long" } });
	await armed;
	assert.equal(h.timers.length, 0);
});
