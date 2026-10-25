import assert from "node:assert";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const idle = await loadModule("idle.ts");
const patches = await loadModule("patches.ts");

const ON = { compaction: true, idleCompaction: true };
const HOUR = 3600_000;

const HOUR_MARK = { type: "ephemeral", ttl: "1h" };
/** An Anthropic request as Pi builds it: markers on the system prompt, the last tool and the last message. */
const anthropic = (mark) => ({
	model: "claude",
	system: [{ type: "text", text: "SYS", cache_control: mark }],
	tools: [{ name: "read", input_schema: {}, cache_control: mark }],
	messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: mark }] }],
});

test("an Anthropic request that asks for an hour's cache lives an hour, with nothing declared", () => {
	assert.equal(idle.requestTtlMs(anthropic(HOUR_MARK), { provider: "p", id: "m" }), HOUR);
	const chatFormat = { model: "m", messages: [{ role: "system", content: [{ type: "text", text: "S", cache_control: HOUR_MARK }] }, { role: "user", content: "hi" }] };
	assert.equal(idle.requestTtlMs(chatFormat, {}), HOUR, "Anthropic-format markers on a chat request (OpenRouter's anthropic/*)");
	assert.equal(idle.requestTtlMs(anthropic({ type: "ephemeral" }), {}), undefined, "no ttl asked: nothing counted on");
	assert.equal(idle.requestTtlMs({ model: "m", input: [], prompt_cache_retention: "24h" }, {}), undefined, "what 24h means is the provider's: declare it");
});

test("a declared promptCache wins, for the tier the request asked for", () => {
	const model = { promptCache: { short: 300, long: 7200 } };
	assert.equal(idle.requestTtlMs(anthropic(HOUR_MARK), model), 7200_000);
	assert.equal(idle.requestTtlMs(anthropic({ type: "ephemeral" }), model), 300_000);
	assert.equal(idle.requestTtlMs({ model: "m", messages: [], prompt_cache_retention: "24h" }, model), 7200_000);
	assert.equal(idle.requestTtlMs({ model: "m", input: [], prompt_cache_options: { ttl: "30m" } }, model), 7200_000);
	assert.equal(idle.requestTtlMs({ model: "m", input: [] }, model), 300_000);
	const shortOnly = { promptCache: { short: 3600 } };
	assert.equal(idle.requestTtlMs({ model: "m", input: [], prompt_cache_retention: "24h" }, shortOnly), undefined, "the long tier is not declared");
	assert.equal(idle.requestTtlMs(anthropic(HOUR_MARK), shortOnly), HOUR, "Anthropic's hour is known all the same");
});

test("a request of any other shape has no known lifetime, and never throws", () => {
	assert.equal(idle.requestTtlMs(null, {}), undefined);
	assert.equal(idle.requestTtlMs({ system: "S", tools: "x", messages: [null, { content: 5 }, { content: [null] }] }, undefined), undefined);
});

test("it fires at 90% of the lifetime, as Claude Code and Pi's warmer do", () => {
	assert.equal(idle.idleDelayMs(HOUR), 3240_000);
	assert.equal(idle.idleDelayMs(60_000), 50_000, "ten seconds of margin at least");
	assert.equal(idle.idleMinTokens({}), 200_000);
	assert.equal(idle.idleMinTokens({ PI_CC_IDLE_COMPACT_MIN_TOKENS: "150000" }), 150_000);
	assert.equal(idle.idleMinTokens({ PI_CC_IDLE_COMPACT_MIN_TOKENS: "5000" }), 100_000, "not below Claude Code's floor");
});

function harness({ now = 1_000_000, tokens = 250_000, idleNow = true, pending = false, env = {} } = {}) {
	const clock = { now };
	const timers = [];
	const compacts = [];
	const notices = [];
	const ctx = {
		model: { provider: "p", id: "m" },
		hasUI: true,
		ui: { notify: (message, level) => notices.push({ message, level }) },
		isIdle: () => idleNow,
		hasPendingMessages: () => pending,
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
		sessionManager: { getSessionId: () => "idle-s" },
		compact: (options) => compacts.push(options),
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
	patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now - 60_000, ttlMs: HOUR });
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
		["five-minute cache", { ttlMs: 300_000 }, ON],
		["half-hour cache", { ttlMs: 1800_000 }, ON],
		["unknown lifetime", { ttlMs: undefined }, ON],
		["small context", { tokens: 199_999 }, ON],
		["busy", { idleNow: false }, ON],
		["queued messages", { pending: true }, ON],
	];
	for (const [label, options, config] of cases) {
		const h = harness(options);
		const ttlMs = "ttlMs" in options ? options.ttlMs : HOUR;
		patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now, ...(ttlMs ? { ttlMs } : {}) });
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
		["newer request", (h) => patches.runtime().captures.set("idle-s", { payload: {}, leafId: "y", at: h.clock.now, ttlMs: HOUR })],
		["busy", (h) => (h.ctx.isIdle = () => false)],
		["lapsed", (h) => (h.clock.now += 61_000)],
		["context shrank", (h) => (h.ctx.getContextUsage = () => ({ tokens: 10, contextWindow: 1 }))],
	]) {
		const h = harness();
		patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now, ttlMs: HOUR });
		await h.compactor.arm(h.ctx, ON);
		h.clock.now += h.timers[0].ms;
		change(h);
		h.timers[0].fn();
		assert.equal(h.compacts.length, 0, label);
	}
});

test("re-arming or cancelling clears the timer; a failed compaction is reported once", async () => {
	const h = harness();
	patches.runtime().captures.set("idle-s", { payload: {}, leafId: "x", at: h.clock.now, ttlMs: HOUR });
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
