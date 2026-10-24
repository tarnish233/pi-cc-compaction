import assert from "node:assert";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const plan = await loadModule("plan.ts");
const breaker = await loadModule("breaker.ts");
const patches = await loadModule("patches.ts");

const MODEL = { provider: "p", id: "m", api: "openai-completions" };
const commit = (sid, capture) => patches.runtime().captures.set(sid, { payload: { model: "m", messages: [] }, leafId: "l", at: 1000, ...capture });

test("a fork is planned from the last answered request of this model, while its cache lives", () => {
	commit("p1", { ttlMs: 3600_000 });
	const ok = plan.forkPlan("p1", MODEL, 1000 + 3599_000);
	assert.equal(ok.ok, true);
	assert.equal(ok.capture.leafId, "l");
	commit("p2", {});
	assert.equal(plan.forkPlan("p2", MODEL, 10 ** 13).ok, true, "a model without promptCache: its cache cannot be known to be gone");
});

test("no fork, and the reason, when no cache can be read", () => {
	patches.runtime().captures.delete("p3");
	assert.deepEqual(plan.forkPlan("p3", MODEL, 0), { ok: false, reason: "no request has been answered yet in this session" });
	assert.deepEqual(plan.forkPlan(undefined, MODEL, 0), { ok: false, reason: "no request has been answered yet in this session" });
	commit("p4", { payload: { model: "other", messages: [] } });
	assert.deepEqual(plan.forkPlan("p4", MODEL, 0), { ok: false, reason: "the last request went to another model" });
	commit("p4b", { modelKey: "elsewhere/m" });
	assert.deepEqual(plan.forkPlan("p4b", MODEL, 0), { ok: false, reason: "the last request went to another model" }, "the same model id on another provider is another cache");
	commit("p4c", { modelKey: "p/m" });
	assert.equal(plan.forkPlan("p4c", MODEL, 0).ok, true);
	commit("p5", {});
	assert.deepEqual(plan.forkPlan("p5", { ...MODEL, api: "google-generative-ai" }, 0), { ok: false, reason: "google-generative-ai requests cannot be forked" });
	commit("p6", { ttlMs: 300_000 });
	assert.deepEqual(plan.forkPlan("p6", MODEL, 1000 + 300_000), { ok: false, reason: "the prompt cache has expired" });
	assert.deepEqual(plan.forkPlan("p6", undefined, 0), { ok: false, reason: "there is no model" });
});

test("the failure breaker opens after three auto-compaction failures in a row; a success closes it", () => {
	const sid = "b1";
	breaker.reset(sid);
	assert.equal(breaker.noteFailure(sid), false);
	assert.equal(breaker.noteFailure(sid), false);
	assert.equal(breaker.isOpen(sid), false);
	assert.equal(breaker.noteFailure(sid), true, "the third trips it");
	assert.equal(breaker.isOpen(sid), true);
	assert.equal(breaker.openReason(sid), "failures");
	breaker.noteSuccess(sid);
	assert.equal(breaker.isOpen(sid), false);
	assert.equal(breaker.noteFailure(sid), false, "counting starts over");
});

test("the thrash breaker: the context refilled within three turns of the last compaction, three times in a row", () => {
	const sid = "b2";
	breaker.reset(sid);
	assert.equal(breaker.noteAutoCompaction(sid), false, "the first compaction refilled nothing");
	breaker.noteSuccess(sid);
	for (const round of [1, 2]) {
		breaker.noteTurn(sid);
		breaker.noteTurn(sid);
		assert.equal(breaker.noteAutoCompaction(sid), false, `rapid refill ${round}`);
		breaker.noteSuccess(sid);
	}
	breaker.noteTurn(sid);
	assert.equal(breaker.noteAutoCompaction(sid), true, "the third rapid refill trips it");
	assert.equal(breaker.openReason(sid), "thrashing");
	// A slow refill resets the count.
	const slow = "b3";
	breaker.reset(slow);
	breaker.noteSuccess(slow);
	breaker.noteTurn(slow);
	assert.equal(breaker.noteAutoCompaction(slow), false);
	breaker.noteSuccess(slow);
	for (let i = 0; i < 3; i++) breaker.noteTurn(slow);
	assert.equal(breaker.noteAutoCompaction(slow), false);
	assert.equal(breaker.state(slow).rapidRefills, 0, "three turns is not rapid");
});
