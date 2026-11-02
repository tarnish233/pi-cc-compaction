import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const prompt = await loadModule("prompt.ts");
const fork = await loadModule("fork.ts");
const response = (text, stopReason = "stop") => ({ stopReason, content: [{ type: "text", text }], usage: { input: 10, output: 20 } });
const invalid = [
	"<analysis>Only scratchpad, no summary.</analysis>",
	"<analysis>Only scratchpad, truncated",
	"I will fix the issue now.",
	"<summary></summary>",
	"<summary> \n </summary>",
	"<summary>",
	"<summary></summ",
	"<summary><analysis>Only scratchpad.</analysis></summary>",
	"<summary><analysis>Only scratchpad, truncated",
	"<analysis><summary>A quoted example, not an actual summary.</summary></analysis>",
];

test("no ordinary answer, scratchpad-only output or empty summary can be committed", () => {
	for (const text of invalid) {
		for (const stopReason of ["stop", "length"]) {
			assert.equal(fork.interpretReply(response(text, stopReason)).ok, false, `${stopReason}: ${text}`);
		}
		assert.equal(prompt.extractSummary(text), undefined, text);
		assert.equal(prompt.formatSummary(text), "", text);
		assert.throws(() => prompt.summaryMessage({ reply: text, keptMessages: false }), /non-empty <summary>/, text);
	}
});

test("complete and useful partial summaries are normalized without their scratchpad", () => {
	for (const text of [
		"<summary>Useful facts</summary>",
		"<summary>Useful facts",
		"<analysis>reasoning</analysis>\n<summary>Useful facts",
		"<analysis>first</analysis><analysis>second</analysis><summary>Useful facts</summary>",
		"<analysis><summary>quoted example</summary></analysis><summary>Useful facts</summary>",
	]) {
		const interpreted = fork.interpretReply(response(text, "length"));
		assert.equal(interpreted.ok, true, text);
		assert.equal(interpreted.reply, text, "keep the original reply and its metadata");
		assert.equal(prompt.formatSummary(text), "Summary:\nUseful facts");
		assert.ok(prompt.summaryMessage({ reply: text, keptMessages: false }).includes("Summary:\nUseful facts"));
	}
});

test("the summary ends at its first closing tag, as Claude Code reads it", () => {
	// The first <analysis> block is dropped first, even when a summary quotes one,
	// and the body ends at the first </summary>.
	const quoted = "Example <summary>nested text</summary>; quoted <analysis>example</analysis>; pending work.";
	assert.equal(prompt.extractSummary(`<summary>${quoted}</summary>`), "Example <summary>nested text");
	const fenced = "Pending work:\n```xml\n<summary>quoted example</summary>\n<analysis>unfinished example\n```\nContinue the tests.";
	assert.equal(prompt.extractSummary(`<summary>${fenced}</summary>`), "Pending work:\n```xml\n<summary>quoted example");
});

test("a reply that quotes the protocol is read the way Claude Code reads it", () => {
	// No fence or quote heuristic: a quoted example is stored like any other
	// summary, and it wins over a real summary below it (first closing tag).
	const fenced = "```xml\n<summary>Only an example</summary>\n```";
	assert.equal(prompt.extractSummary(fenced), "Only an example");
	assert.equal(prompt.formatSummary(fenced), "Summary:\nOnly an example");
	assert.equal(prompt.extractSummary(`${fenced}\n<summary>Real facts</summary>`), "Only an example");
	assert.equal(prompt.extractSummary('Reject "<summary>quoted</summary>" here.'), "quoted");
	// An unfinished scratchpad that happens to quote the tags reads the same way.
	assert.equal(prompt.extractSummary("<analysis>Unfinished scratchpad with <summary>a quoted example</summary>"), "a quoted example");
});

test("a stray inline backtick or an unclosed fence cannot hide a summary written without a fence", () => {
	for (const reply of [
		"<analysis>the flag is ` not a pair yet</analysis>\n<summary>Files: `src/index.ts`</summary>",
		"<analysis>example:\n```ts\nconst a = 1;\n</analysis>\n<summary>Files: `src/index.ts`</summary>",
	]) assert.equal(prompt.extractSummary(reply), "Files: `src/index.ts`", reply);
});

test("quoted tags in the scratchpad cannot hide the real summary", () => {
	for (const scratchpad of [
		'Reject `<analysis>` only, including "<summary>quoted example</summary>".',
		"Reject ‘<analysis>’ and “<summary>example</summary>”.",
		"Example:\n```xml\n<analysis>unfinished example\n<summary>fake example\n```\nActual reasoning.",
	]) assert.equal(prompt.formatSummary(`<analysis>${scratchpad}</analysis><summary>Real facts</summary>`), "Summary:\nReal facts");
});

test("split text blocks retain a useful partial summary and provider metadata", () => {
	const usage = { input: 1, cacheRead: 99, output: 10 };
	const reply = fork.interpretReply({
		provider: "p", model: "m", responseModel: "m-version", stopReason: "length", usage,
		content: [{ type: "thinking" }, { type: "text", text: "<analysis>reasoning</analysis>" }, { type: "text", text: "<summary>Facts" }, { type: "text", text: "and pending work" }],
	});
	assert.equal(reply.ok, true);
	assert.equal(reply.usage, usage);
	assert.equal(reply.responseModel, "m-version");
	assert.equal(prompt.formatSummary(reply.reply), "Summary:\nFacts\nand pending work");
});

test("a reply with no usable summary says how it stopped and what it wrote", async () => {
	const empty = fork.interpretReply({ stopReason: "stop", content: [], usage: {} });
	assert.equal(empty.unusableSummary, true, "an empty reply is re-asked too, not cancelled");
	assert.ok(empty.reason.startsWith(prompt.INVALID_SUMMARY) && empty.reason.includes("stop"), empty.reason);
	const cappedEmpty = fork.interpretReply({ stopReason: "length", content: [], usage: { output: 0 } });
	assert.ok(cappedEmpty.reason.startsWith(prompt.SUMMARY_TRUNCATED), "a cap that left no text is named as one");
	assert.ok(cappedEmpty.reason.includes("length, 0 output tokens"), cappedEmpty.reason);
	const truncated = fork.interpretReply(response("<analysis>still writing", "length"));
	assert.equal(truncated.ok, false);
	assert.equal(truncated.unusableSummary, true);
	assert.ok(truncated.reason.startsWith(prompt.SUMMARY_TRUNCATED), truncated.reason);
	assert.ok(truncated.reason.includes("length, 20 output tokens"), truncated.reason);
	assert.ok(truncated.reason.includes('"<analysis>still writing"'), truncated.reason);
	const prose = fork.interpretReply(response("x".repeat(400) + "I will fix the issue now."));
	assert.ok(prose.reason.startsWith(prompt.INVALID_SUMMARY), prose.reason);
	assert.ok(prose.reason.includes("stop, 20 output tokens"), prose.reason);
	assert.ok(prose.reason.includes(`${"x".repeat(120)} … `), prose.reason);
	assert.ok(prose.reason.endsWith(`I will fix the issue now.")`), prose.reason);
});

test("an unusable summary is asked for once more, with a stricter ask, then fails for good", async () => {
	const payload = { model: "m", messages: [{ role: "user", content: "cached conversation" }], max_tokens: 30000 };
	const sent = [];
	const ctx = {
		model: { provider: "p", id: "m", api: "openai-completions" },
		sessionManager: { getSessionId: () => "escalate-test" },
		modelRegistry: { complete: async (_model, _context, options) => { sent.push(await options.onPayload({})); return response("<analysis>no summary"); } },
	};
	const stricter = (current) => ({ ...current, messages: [...current.messages, { role: "user", content: prompt.SUMMARY_ONLY_ASK }] });
	const result = await fork.forkWithRetry(ctx, payload, undefined, { maxRetries: 3, baseDelayMs: 1, sleep: async () => {} }, stricter);
	assert.equal(result.ok, false);
	assert.equal(result.unusableSummary, true);
	assert.equal(result.attempts, 2, "one stricter ask, then done");
	assert.deepEqual(sent[0], payload, "the first attempt is the request itself");
	assert.deepEqual(sent[1].messages.slice(0, -1), payload.messages, "the same cached prefix");
	assert.deepEqual(sent[1].messages.at(-1), { role: "user", content: prompt.SUMMARY_ONLY_ASK });
});

test("without an escalation ask, an unusable summary fails closed: no extra requests, no backoff, prefix intact", async () => {
	for (const text of invalid) {
		const payload = { model: "m", messages: [{ role: "user", content: "cached conversation" }], tools: [{ name: "read" }], max_tokens: 30000 };
		const before = structuredClone(payload), sent = [], delays = [];
		const ctx = {
			model: { provider: "p", id: "m", api: "openai-completions" },
			sessionManager: { getSessionId: () => "invalid-summary-test" },
			modelRegistry: { complete: async (_model, _context, options) => { sent.push(await options.onPayload({})); return response(text, "length"); } },
		};
		const result = await fork.forkWithRetry(ctx, payload, undefined, { maxRetries: 3, baseDelayMs: 1, sleep: async (ms) => delays.push(ms) });
		assert.equal(result.ok, false, text);
		assert.equal(result.attempts, 1, "do not retry unusable summaries as transport errors");
		assert.deepEqual(delays, []);
		assert.deepEqual(payload, before);
		assert.deepEqual(sent, [payload]);
	}
});

test("the quoted reply is one line: newlines and terminal escapes never reach the notice", () => {
	const reply = fork.interpretReply(response("<analysis>\u001b[31mred\u001b[0m\nstill writing", "length"));
	assert.ok(!reply.reason.includes("\u001b"), reply.reason);
	assert.ok(!reply.reason.includes("\n"), reply.reason);
	assert.ok(reply.reason.includes('"<analysis> [31mred [0m still writing"'), "the text is kept, the escape character is not");
});
