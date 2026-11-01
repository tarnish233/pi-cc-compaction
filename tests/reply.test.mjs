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
	"<analysis>Unfinished scratchpad with <summary>a quoted example</summary>",
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

test("tags quoted inside the real summary are preserved rather than stripped as scratchpad", () => {
	const body = "Example <summary>nested text</summary>; quoted <analysis>example</analysis>; pending work.";
	assert.equal(prompt.extractSummary(`<summary>${body}</summary>`), body);
	assert.equal(prompt.formatSummary(`<summary>${body}</summary>`), `Summary:\n${body}`);
});

test("literal tags in scratchpad quotes and code do not hide a real summary", () => {
	for (const scratchpad of [
		'Reject `<analysis>` only, including "<summary>quoted example</summary>".',
		"Reject ‘<analysis>’ and “<summary>example</summary>”.",
		"Example:\n```xml\n<analysis>unfinished example\n<summary>fake example\n```\nActual reasoning.",
	]) assert.equal(prompt.formatSummary(`<analysis>${scratchpad}</analysis><summary>Real facts</summary>`), "Summary:\nReal facts");
});

test("code examples in a summary are not mistaken for protocol tags", () => {
	const body = "Pending work:\n```xml\n<summary>quoted example</summary>\n<analysis>unfinished example\n```\nContinue the tests.";
	assert.equal(prompt.formatSummary(`<summary>${body}</summary>`), `Summary:\n${body}`);
	assert.equal(prompt.extractSummary("```xml\n<summary>Only an example</summary>\n```"), undefined);
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

test("invalid summaries fail closed without extra requests, backoff or prefix mutation", async () => {
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
