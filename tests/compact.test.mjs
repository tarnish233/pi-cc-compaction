import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const compact = await loadModule("compact.ts");
const patches = await loadModule("patches.ts");
const breaker = await loadModule("breaker.ts");
const prompt = await loadModule("prompt.ts");

const ON = { compaction: true, idleCompaction: true };
const NO_WAIT = { retry: { maxRetries: 3, baseDelayMs: 1, sleep: async () => {} } };
const user = (id, text) => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id, content, stopReason = "toolUse") => ({ id, type: "message", message: { role: "assistant", content, stopReason } });
const toolResult = (id, text) => ({ id, type: "message", message: { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text }] } });

/** u1 -> a1 (read) -> r1 -> a2 (final): the answered request carried u1..r1; a2 answered it. */
function conversation(dir = "/work") {
	return [
		user("u1", "fix the bug"),
		assistant("a1", [{ type: "toolCall", id: "t", name: "read", arguments: { path: path.join(dir, "bug.ts") } }]),
		toolResult("r1", "const bug = 1;"),
		assistant("a2", [{ type: "text", text: "Fixed." }], "stop"),
	];
}

const MODEL = { provider: "p", id: "m", api: "openai-completions", contextWindow: 1_000_000, maxTokens: 128_000 };

function fakeCtx({ entries, model = MODEL, replies = [], sessionId = "s1", cwd = "/work" }) {
	const seen = { sent: [], notices: [] };
	const ctx = {
		model,
		cwd,
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
				seen.sent.push(sent);
				const next = replies.shift();
				if (!next) throw new Error("no reply scripted");
				if (next instanceof Error) throw next;
				return next;
			},
		},
	};
	return { ctx, seen };
}

function event(entries, overrides = {}) {
	return {
		type: "session_before_compact",
		preparation: { firstKeptEntryId: "a2", tokensBefore: 5000, messagesToSummarize: [], turnPrefixMessages: [], fileOps: {} },
		branchEntries: entries,
		customInstructions: undefined,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		...overrides,
	};
}

const LIVE = { model: "m", messages: [{ role: "system", content: "SYS" }, { role: "user", content: "fix the bug" }, { role: "tool", content: "const bug = 1;" }], stream: true };
function answered(sessionId, leafId = "r1", extra = {}) {
	breaker.reset(sessionId);
	patches.runtime().pending.delete(sessionId);
	patches.runtime().captures.set(sessionId, { payload: LIVE, leafId, at: Date.now(), ...extra });
}
const reply = (text, stopReason = "stop") => ({ role: "assistant", stopReason, content: [{ type: "text", text }], usage: { input: 10, cacheRead: 9000, output: 300 } });
const failure = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage, content: [] });

test("with Claude Code's compaction off, Pi's own runs", async () => {
	const entries = conversation();
	answered("s1");
	const { ctx, seen } = fakeCtx({ entries });
	assert.equal(await compact.handleCompaction(event(entries), ctx, { ...ON, compaction: false }, NO_WAIT), undefined);
	assert.equal(seen.sent.length, 0);
});

test("the fork: the answered request plus Claude Code's ask; what came after it is kept", async () => {
	const entries = conversation();
	answered("s1");
	const { ctx, seen } = fakeCtx({ entries, replies: [reply("<analysis>a</analysis>\n<summary>\nS\n</summary>")] });
	const result = await compact.handleCompaction(event(entries, { customInstructions: "keep test names" }), ctx, ON, NO_WAIT);
	assert.deepEqual(seen.sent[0].messages.slice(0, -1), LIVE.messages);
	assert.deepEqual(seen.sent[0].messages.at(-1), { role: "user", content: prompt.summaryRequest("keep test names") });
	const c = result.compaction;
	assert.equal(c.firstKeptEntryId, "a2", "the reply to the answered request stays verbatim");
	assert.equal(c.tokensBefore, 5000);
	assert.deepEqual(c.usage, { input: 10, cacheRead: 9000, output: 300 });
	assert.equal(c.details.engine, "fork");
	assert.ok(c.summary.startsWith(prompt.CONTINUATION_OPENER));
	assert.ok(c.summary.includes("<tools-used-before-summary>read</tools-used-before-summary>\nSummary:\nS"));
	assert.ok(c.summary.includes("read the full transcript at: /sessions/s1.jsonl"));
	assert.ok(c.summary.includes(prompt.KEPT_MESSAGES_NOTE));
});

test("the compaction record names the model that wrote the summary, the way Pi's replies do", async () => {
	const entries = conversation();
	answered("s1");
	const named = { ...reply("<summary>S</summary>"), provider: "p", model: "m", responseModel: "m-2026-01" };
	let { ctx } = fakeCtx({ entries, replies: [named] });
	let details = (await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT)).compaction.details;
	assert.deepEqual([details.provider, details.model, details.responseModel], ["p", "m", "m-2026-01"]);

	// A reply that does not say: the model the fork was sent to.
	answered("s1");
	({ ctx } = fakeCtx({ entries, replies: [reply("<summary>S</summary>")] }));
	details = (await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT)).compaction.details;
	assert.deepEqual([details.provider, details.model], [MODEL.provider, MODEL.id]);
	assert.equal("responseModel" in details, false);
});

test("no cache to read: Pi's own compaction runs, and the user is told why, once", async () => {
	const entries = conversation();
	const cases = [
		["no request answered", () => patches.runtime().captures.delete("s1"), MODEL, /no request has been answered yet/],
		["another model", () => answered("s1", "r1", { payload: { ...LIVE, model: "other" } }), MODEL, /another model/],
		["cache expired", () => answered("s1", "r1", { at: Date.now() - 3600_000, ttlMs: 300_000 }), MODEL, /prompt cache has expired/],
		["API not forkable", () => answered("s1"), { ...MODEL, api: "google-generative-ai" }, /cannot be forked/],
	];
	for (const [label, arrange, model, pattern] of cases) {
		arrange();
		const { ctx, seen } = fakeCtx({ entries, model, sessionId: `s1` });
		compact.resetNotices();
		assert.equal(await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT), undefined, label);
		assert.equal(await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT), undefined, label);
		assert.equal(seen.sent.length, 0, `${label}: nothing sent`);
		assert.equal(seen.notices.length, 1, `${label}: told once`);
		assert.match(seen.notices[0].message, pattern);
		assert.match(seen.notices[0].message, /Pi's own compaction/);
	}
});

test("an answered request that is not on this branch cancels instead of handing Pi a keepRecentTokens:1 it never chose", async () => {
	const entries = conversation();
	// The capture points at an entry that is not on the branch (a fork away).
	answered("s1", "gone-from-branch");
	const { ctx, seen } = fakeCtx({ entries });
	compact.resetNotices();
	assert.deepEqual(await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT), { cancel: true });
	assert.equal(seen.sent.length, 0, "nothing is sent");
	assert.match(seen.notices[0].message, /not on this branch/);
});

test("overflow recovery forks the request that succeeded before the one that overflowed", async () => {
	const entries = [...conversation(), user("u2", "now read the huge log")];
	answered("s1");
	// The overflowing request is in flight only; it never became the one to fork.
	patches.runtime().pending.set("s1", { payload: { model: "m", messages: ["too", "long"] }, leafId: "u2", at: Date.now() });
	const { ctx, seen } = fakeCtx({ entries, replies: [reply("<summary>S</summary>")] });
	const result = await compact.handleCompaction(event(entries, { reason: "overflow", willRetry: true }), ctx, ON, NO_WAIT);
	assert.deepEqual(seen.sent[0].messages.slice(0, -1), LIVE.messages, "the cached prefix");
	assert.equal(result.compaction.firstKeptEntryId, "a2", "the round after it, the overflowing input included, is kept");
});

test("a large kept round is still kept: the fork reads the cache, no fallback request", async () => {
	const entries = [user("u1", "read the log"), assistant("a0", [{ type: "text", text: "ok" }], "stop"), user("u2", "now"), assistant("a1", [{ type: "toolCall", id: "t", name: "bash", arguments: {} }]), toolResult("r1", "x".repeat(200_000))];
	answered("s1", "u2");
	const { ctx, seen } = fakeCtx({ entries, model: { ...MODEL, contextWindow: 60_000 }, replies: [reply("<summary>S</summary>")] });
	const result = await compact.handleCompaction(event(entries, { reason: "threshold" }), ctx, ON, NO_WAIT);
	assert.equal(seen.sent.length, 1);
	assert.equal(result.compaction.firstKeptEntryId, "a1");
	assert.equal(result.compaction.details.engine, "fork");
});

test("fewer than two rounds: Claude Code's 'Not enough messages to compact.'", async () => {
	const entries = [user("u1", "hi"), assistant("a1", [{ type: "text", text: "hello" }], "stop")];
	answered("s1", "u1");
	const { ctx, seen } = fakeCtx({ entries });
	assert.deepEqual(await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT), { cancel: true });
	assert.equal(seen.sent.length, 0);
	assert.deepEqual(seen.notices, [{ message: "Not enough messages to compact.", level: "error" }]);
});

test("a failed /compact is cancelled with Claude Code's message; Pi's compaction never runs", async () => {
	const entries = conversation();
	answered("s1");
	const fatal = fakeCtx({ entries, replies: [failure("invalid x-api-key")] });
	assert.deepEqual(await compact.handleCompaction(event(entries), fatal.ctx, ON, NO_WAIT), { cancel: true });
	assert.deepEqual(fatal.seen.notices, [{ message: "Error during compaction: invalid x-api-key", level: "error" }]);
	const over = failure("prompt is too long: 1001 tokens > 1000 maximum");
	const tooLong = fakeCtx({ entries, replies: [over, over] });
	assert.deepEqual(await compact.handleCompaction(event(entries), tooLong.ctx, ON, NO_WAIT), { cancel: true });
	assert.deepEqual(tooLong.seen.notices, [{ message: "Compaction failed \u00b7 conversation could not be reduced below the context limit", level: "error" }]);
});

test("transient errors are retried before anything fails", async () => {
	const entries = conversation();
	answered("s1");
	const { ctx, seen } = fakeCtx({ entries, replies: [new Error("fetch failed"), failure("503 Service Unavailable"), reply("<summary>S</summary>")] });
	const result = await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT);
	assert.equal(result.compaction.details.engine, "fork");
	assert.equal(seen.sent.length, 3);
	assert.equal(seen.notices.length, 0);
});

test("three automatic failures in a row open the breaker; the third says so", async () => {
	const entries = conversation();
	answered("s2");
	for (let i = 1; i <= 3; i++) {
		const { ctx, seen } = fakeCtx({ entries, sessionId: "s2", replies: [failure("invalid x-api-key")] });
		assert.deepEqual(await compact.handleCompaction(event(entries, { reason: "threshold" }), ctx, ON, NO_WAIT), { cancel: true });
		assert.match(seen.notices[0].message, /^Auto-compaction failed: Error during compaction: invalid x-api-key/);
		assert.equal(seen.notices[0].level, "warning");
		if (i < 3) assert.equal(seen.notices.length, 1);
		else assert.match(seen.notices[1].message, /failed 3 times in a row/);
		breaker.noteTurn("s2");
		breaker.noteTurn("s2");
		breaker.noteTurn("s2");
	}
	assert.equal(breaker.isOpen("s2"), true);
});

test("thrashing: refilled within three turns of the last compaction, three times in a row", async () => {
	const entries = conversation();
	answered("s3");
	breaker.noteSuccess("s3");
	let last;
	for (let i = 1; i <= 3; i++) {
		breaker.noteTurn("s3");
		const { ctx, seen } = fakeCtx({ entries, sessionId: "s3", replies: [reply("<summary>S</summary>")] });
		last = { result: await compact.handleCompaction(event(entries, { reason: "threshold" }), ctx, ON, NO_WAIT), seen };
		if (i < 3) breaker.noteSuccess("s3");
	}
	assert.deepEqual(last.result, { cancel: true });
	assert.equal(last.seen.sent.length, 0, "it does not compact again");
	assert.equal(
		last.seen.notices[0].message,
		"Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.",
	);
	assert.equal(breaker.openReason("s3"), "thrashing");
});

test("an aborted compaction is cancelled, not handed to Pi", async () => {
	const entries = conversation();
	answered("s1");
	const controller = new AbortController();
	const { ctx } = fakeCtx({ entries, replies: [failure("aborted by the user")] });
	controller.abort();
	assert.deepEqual(await compact.handleCompaction(event(entries, { signal: controller.signal }), ctx, ON, NO_WAIT), { cancel: true });
});

test("tool names carry over from the previous summary", async () => {
	const summary = `${prompt.CONTINUATION_OPENER}\n\n<tools-used-before-summary>grep, bash</tools-used-before-summary>\nSummary:\nx`;
	const previous = { id: "c0", type: "message", message: { role: "compactionSummary", summary } };
	const entries = [previous, ...conversation()];
	answered("s1");
	const { ctx } = fakeCtx({ entries, replies: [reply("<summary>S</summary>")] });
	const result = await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT);
	assert.ok(result.compaction.summary.includes("<tools-used-before-summary>bash, grep, read</tools-used-before-summary>"));
});

test("only a summary's own tool list carries over: not a tag quoted in a message, a tool result or the summary's body", async () => {
	const tag = (names) => `<tools-used-before-summary>${names}</tools-used-before-summary>`;
	const previous = { id: "c0", type: "message", message: { role: "compactionSummary", summary: `Pi's own summary\n${tag("quoted")}\n` } };
	const entries = [
		previous,
		user("u0", `look at ${tag("pasted")}`),
		assistant("a0", [{ type: "toolCall", id: "t0", name: "grep", arguments: {} }, { type: "text", text: tag("said") }]),
		toolResult("r0", `let text = \`\${OPENER}\n\n${tag("${tools}")}\``),
		...conversation(),
	];
	answered("s1");
	const { ctx } = fakeCtx({ entries, replies: [reply("<summary>S</summary>")] });
	const result = await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT);
	assert.ok(result.compaction.summary.includes(`${tag("grep, read")}\nSummary:`), result.compaction.summary.slice(0, 400));
});

test("a carried tool name Claude Code would reject is dropped", async () => {
	const summary = `${prompt.CONTINUATION_OPENER}\n\n<tools-used-before-summary>bash, two  spaces, ${"x".repeat(257)}</tools-used-before-summary>\nSummary:\nx`;
	const entries = [{ id: "c0", type: "message", message: { role: "compactionSummary", summary } }, ...conversation()];
	answered("s1");
	const { ctx } = fakeCtx({ entries, replies: [reply("<summary>S</summary>")] });
	const result = await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT);
	assert.ok(result.compaction.summary.includes("<tools-used-before-summary>bash, read</tools-used-before-summary>"));
});

test("the files read before the summary are read again after it", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-compaction-"));
	fs.writeFileSync(path.join(dir, "bug.ts"), "const bug = 0;\n");
	const entries = conversation(dir);
	answered("s1");
	const { ctx } = fakeCtx({ entries, cwd: dir, replies: [reply("<summary>S</summary>")] });
	const result = await compact.handleCompaction(event(entries), ctx, ON, NO_WAIT);
	assert.ok(result.compaction.summary.endsWith(`Result of calling the read tool:\nconst bug = 0;\n`));
	assert.deepEqual(result.compaction.details.restoredFiles, [path.join(dir, "bug.ts")]);
});
