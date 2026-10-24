import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const compact = await loadModule("compact.ts");
const patches = await loadModule("patches.ts");
const prompt = await loadModule("prompt.ts");

const ON = { compaction: true, idleCompaction: true };
const user = (id, text) => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id, content) => ({ id, type: "message", message: { role: "assistant", content } });
const toolResult = (id, text) => ({ id, type: "message", message: { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text }] } });

/** u1 -> a1 (read) -> r1 -> a2 (final): the last request carried u1..r1; a2 answered it. */
function conversation(dir = "/work") {
	return [
		user("u1", "fix the bug"),
		assistant("a1", [{ type: "toolCall", id: "t", name: "read", arguments: { path: path.join(dir, "bug.ts") } }]),
		toolResult("r1", "const bug = 1;"),
		assistant("a2", [{ type: "text", text: "Fixed." }]),
	];
}

function fakeCtx({ entries, model = { provider: "p", id: "m", api: "openai-completions", reasoning: true }, complete, streamSimple, sessionId = "s1", cwd = "/work" }) {
	const seen = { complete: [], streamSimple: [], notices: [] };
	const ctx = {
		model,
		cwd,
		thinkingLevel: "high",
		hasUI: true,
		ui: { notify: (message, level) => seen.notices.push({ message, level }) },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => "/sessions/s1.jsonl",
			getBranch: () => entries,
			buildSessionProjection: () => ({
				entries: entries.map((entry) => ({ sourceEntry: entry, messages: entry.type === "message" ? [entry.message] : [] })),
				messages: entries.filter((entry) => entry.type === "message").map((entry) => entry.message),
			}),
		},
		modelRegistry: {
			async complete(m, context, options) {
				const sent = await options.onPayload?.({ stub: true }, m);
				seen.complete.push({ model: m, sent, options });
				if (!complete) throw new Error("complete not expected");
				return complete(sent);
			},
			streamSimple(m, context, options) {
				seen.streamSimple.push({ model: m, context, options });
				return { result: async () => (streamSimple ? streamSimple(context) : { stopReason: "error", errorMessage: "no fallback", content: [] }) };
			},
		},
	};
	return { ctx, seen };
}

function event(overrides = {}) {
	return {
		type: "session_before_compact",
		preparation: { firstKeptEntryId: "a2", tokensBefore: 5000, messagesToSummarize: [], turnPrefixMessages: [], fileOps: {} },
		branchEntries: overrides.entries,
		customInstructions: undefined,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		...overrides,
	};
}

function capture(sessionId, leafId, payload) {
	patches.runtime().captures.set(sessionId, { payload, leafId, at: Date.now() });
}

const reply = (text) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }], usage: { input: 10, cacheRead: 9000, output: 300 } });
const LIVE = { model: "m", messages: [{ role: "system", content: "SYS" }, { role: "user", content: "fix the bug" }, { role: "tool", content: "const bug = 1;" }], stream: true };

test("with Claude Code's compaction off, Pi's own runs", async () => {
	const entries = conversation();
	const { ctx, seen } = fakeCtx({ entries });
	assert.equal(await compact.handleCompaction(event({ entries }), ctx, { ...ON, compaction: false }), undefined);
	assert.equal(seen.complete.length + seen.streamSimple.length, 0);
});

test("the fork: the live request plus Claude Code's ask; what came after it is kept", async () => {
	const entries = conversation();
	capture("s1", "r1", LIVE);
	const { ctx, seen } = fakeCtx({ entries, complete: () => reply("<analysis>a</analysis>\n<summary>\nS\n</summary>") });
	const result = await compact.handleCompaction(event({ entries, customInstructions: "keep test names" }), ctx, ON);
	const sent = seen.complete[0].sent;
	assert.deepEqual(sent.messages.slice(0, -1), LIVE.messages);
	assert.deepEqual(sent.messages.at(-1), { role: "user", content: prompt.summaryRequest("keep test names") });
	assert.equal(seen.streamSimple.length, 0);
	const c = result.compaction;
	assert.equal(c.firstKeptEntryId, "a2", "the reply to the captured request stays verbatim");
	assert.equal(c.tokensBefore, 5000);
	assert.deepEqual(c.usage, { input: 10, cacheRead: 9000, output: 300 });
	assert.equal(c.details.engine, "fork");
	assert.ok(c.summary.startsWith(prompt.CONTINUATION_OPENER));
	assert.ok(c.summary.includes("<tools-used-before-summary>read</tools-used-before-summary>\nSummary:\nS"));
	assert.ok(c.summary.includes("read the full transcript at: /sessions/s1.jsonl"));
	assert.ok(c.summary.includes(prompt.KEPT_MESSAGES_NOTE));
});

test("a capture of another model, or one a compaction already covered, falls back to the summary request", async () => {
	for (const [label, entries, payload] of [
		["other model", conversation(), { ...LIVE, model: "other" }],
		["stale", [...conversation(), { id: "c1", type: "compaction", summary: "old", firstKeptEntryId: "a2" }, user("u2", "next")], LIVE],
	]) {
		capture("s1", "r1", payload);
		const { ctx, seen } = fakeCtx({ entries, streamSimple: () => reply("<summary>D</summary>") });
		const result = await compact.handleCompaction(event({ entries }), ctx, ON);
		assert.equal(seen.complete.length, 0, label);
		assert.equal(result.compaction.details.engine, "summary-request", label);
		assert.ok(result.compaction.summary.includes("Summary:\nD"), label);
	}
});

test("the summary request: Claude Code's fallback system prompt, the conversation as text, the last round kept", async () => {
	const entries = conversation();
	patches.runtime().captures.delete("s1");
	const { ctx, seen } = fakeCtx({ entries, streamSimple: () => reply("<summary>D</summary>") });
	const result = await compact.handleCompaction(event({ entries }), ctx, ON);
	const call = seen.streamSimple[0];
	assert.equal(call.context.systemPrompt, prompt.DEDICATED_SYSTEM_PROMPT);
	const text = call.context.messages[0].content[0].text;
	assert.ok(text.startsWith("<conversation>\n[User]: fix the bug"));
	assert.ok(text.includes("[Tool result]: const bug = 1;"));
	assert.ok(!text.includes("Fixed."), "the kept round is not summarized");
	assert.ok(text.endsWith(prompt.summaryRequest()));
	assert.equal(call.options.reasoning, "high", "the session's thinking level, unchanged");
	assert.equal(result.compaction.firstKeptEntryId, "a2", "Claude Code keeps the last API round");
});

test("a failed fork falls back to the summary request; overflow goes straight to it", async () => {
	const entries = conversation();
	capture("s1", "r1", LIVE);
	const failing = fakeCtx({ entries, complete: () => ({ stopReason: "error", errorMessage: "boom", content: [] }), streamSimple: () => reply("<summary>D</summary>") });
	const after = await compact.handleCompaction(event({ entries }), failing.ctx, ON);
	assert.equal(failing.seen.complete.length, 1);
	assert.equal(after.compaction.details.engine, "summary-request");
	const overflow = fakeCtx({ entries, streamSimple: () => reply("<summary>D</summary>") });
	const recovered = await compact.handleCompaction(event({ entries, reason: "overflow", willRetry: true }), overflow.ctx, ON);
	assert.equal(overflow.seen.complete.length, 0, "the request that overflowed cannot be forked");
	assert.equal(recovered.compaction.details.engine, "summary-request");
});

test("when both fail, Pi's own compaction runs, and the user is told once", async () => {
	const entries = conversation();
	capture("s1", "r1", LIVE);
	const { ctx, seen } = fakeCtx({ entries, complete: () => ({ stopReason: "error", errorMessage: "boom", content: [] }) });
	assert.equal(await compact.handleCompaction(event({ entries }), ctx, ON), undefined);
	assert.equal(await compact.handleCompaction(event({ entries }), ctx, ON), undefined);
	assert.equal(seen.notices.length, 1);
	assert.match(seen.notices[0].message, /Pi's own compaction/);
	assert.equal(seen.notices[0].level, "warning");
});

test("a capture with nothing after it keeps nothing", async () => {
	const entries = conversation().slice(0, 3);
	capture("s1", "r1", LIVE);
	const { ctx } = fakeCtx({ entries, complete: () => reply("<summary>S</summary>") });
	const result = await compact.handleCompaction(event({ entries }), ctx, ON);
	assert.equal(result.compaction.firstKeptEntryId, null, "Pi records a keep-nothing compaction");
	assert.ok(!result.compaction.summary.includes(prompt.KEPT_MESSAGES_NOTE));
});

test("a kept round that alone fills the threshold is summarized too: nothing is kept", async () => {
	// The captured request carried only u1; a1 and its 50K-token result came after it.
	const entries = [user("u1", "read the log"), assistant("a1", [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "cat log" } }]), toolResult("r1", "x".repeat(200_000))];
	capture("s1", "u1", LIVE);
	const model = { provider: "p", id: "m", api: "openai-completions", contextWindow: 60_000, maxTokens: 128_000 };
	const { ctx, seen } = fakeCtx({ entries, model, streamSimple: () => reply("<summary>D</summary>") });
	const result = await compact.handleCompaction(event({ entries, reason: "threshold" }), ctx, ON);
	assert.equal(seen.complete.length, 0, "the fork never saw that round");
	assert.equal(result.compaction.firstKeptEntryId, null);
	assert.match(result.compaction.details.forkSkipped, /threshold/);
	const text = seen.streamSimple[0].context.messages[0].content[0].text;
	assert.ok(text.includes("[Assistant tool calls]: bash("), "the round is in the summary request");
	assert.ok(text.length < 20_000, "its tool result cut short, so the request fits");
	assert.ok(!result.compaction.summary.includes(prompt.KEPT_MESSAGES_NOTE));
	// Under the threshold (60K - 33K = 27K) the round stays verbatim as usual.
	const small = [user("u1", "read the log"), assistant("a1", [{ type: "toolCall", id: "t", name: "bash", arguments: {} }]), toolResult("r1", "x".repeat(40_000))];
	const fine = fakeCtx({ entries: small, model, complete: () => reply("<summary>S</summary>") });
	const kept = await compact.handleCompaction(event({ entries: small, reason: "threshold" }), fine.ctx, ON);
	assert.equal(kept.compaction.firstKeptEntryId, "a1");
	assert.equal(kept.compaction.details.engine, "fork");
});

test("tool names carry over from the previous summary", async () => {
	const previous = { id: "c0", type: "message", message: { role: "user", content: [{ type: "text", text: "x\n<tools-used-before-summary>grep, bash</tools-used-before-summary>\ny" }] } };
	const entries = [previous, ...conversation()];
	capture("s1", "r1", LIVE);
	const { ctx } = fakeCtx({ entries, complete: () => reply("<summary>S</summary>") });
	const result = await compact.handleCompaction(event({ entries }), ctx, ON);
	assert.ok(result.compaction.summary.includes("<tools-used-before-summary>bash, grep, read</tools-used-before-summary>"));
});

test("the files read before the summary are read again after it", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-compact-"));
	fs.writeFileSync(path.join(dir, "bug.ts"), "const bug = 0;\n");
	const entries = conversation(dir);
	capture("s1", "r1", LIVE);
	const { ctx } = fakeCtx({ entries, cwd: dir, complete: () => reply("<summary>S</summary>") });
	const result = await compact.handleCompaction(event({ entries }), ctx, ON);
	assert.ok(result.compaction.summary.endsWith(`Result of calling the read tool:\nconst bug = 0;\n`));
	assert.deepEqual(result.compaction.details.restoredFiles, [path.join(dir, "bug.ts")]);
});
