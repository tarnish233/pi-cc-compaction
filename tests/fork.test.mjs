import assert from "node:assert";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const fork = await loadModule("fork.ts");
const ASK = "SUMMARIZE";

test("openai-completions: the captured request, unchanged, plus one user turn", () => {
	const payload = {
		model: "beam-free",
		messages: [
			{ role: "system", content: "SYSTEM" },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "1", content: "file body" },
		],
		tools: [{ type: "function", function: { name: "read", parameters: {} } }],
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: 4096,
		reasoning_effort: "high",
		user: "set by another extension",
	};
	const before = structuredClone(payload);
	const out = fork.buildForkPayload("openai-completions", payload, ASK);
	assert.deepEqual(payload, before, "the capture is not mutated");
	assert.deepEqual(out.messages.slice(0, -1), payload.messages, "the prefix is byte-for-byte the live request");
	assert.deepEqual(out.messages.at(-1), { role: "user", content: ASK });
	const { messages: _a, ...restOut } = out;
	const { messages: _b, ...restIn } = payload;
	assert.deepEqual(restOut, restIn, "tools, thinking, output cap and stream fields as the live request had them");
});

test("anthropic-messages: the ask joins the last user turn after its cache marker", () => {
	const marker = { type: "ephemeral" };
	const payload = {
		model: "claude-opus-5-5",
		system: [{ type: "text", text: "SYSTEM", cache_control: marker }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "body", cache_control: marker }] },
		],
		tools: [{ name: "read", input_schema: {} }],
		thinking: { type: "adaptive" },
		metadata: { user_id: "user_pi_account_pi_session_x" },
		max_tokens: 128000,
		stream: true,
	};
	const before = structuredClone(payload);
	const out = fork.buildForkPayload("anthropic-messages", payload, ASK);
	assert.deepEqual(payload, before);
	assert.equal(out.messages.length, payload.messages.length, "no new turn: consecutive user turns would merge anyway");
	assert.deepEqual(out.messages.slice(0, -1), payload.messages.slice(0, -1));
	const last = out.messages.at(-1);
	assert.deepEqual(last.content.slice(0, -1), payload.messages.at(-1).content, "the marked block stays where the cache was written");
	assert.deepEqual(last.content.at(-1), { type: "text", text: ASK }, "the ask carries no marker: read the cache, write nothing new");
	assert.deepEqual(out.metadata, payload.metadata);
	assert.deepEqual(out.thinking, payload.thinking);
	assert.deepEqual(out.system, payload.system);
});

test("anthropic-messages: after an assistant turn the ask is a new user turn", () => {
	const payload = {
		model: "m",
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "text", text: "yo" }] },
		],
	};
	const out = fork.buildForkPayload("anthropic-messages", payload, ASK);
	assert.equal(out.messages.length, 3);
	assert.deepEqual(out.messages[2], { role: "user", content: [{ type: "text", text: ASK }] });
	const plain = fork.buildForkPayload("anthropic-messages", { model: "m", messages: [{ role: "user", content: "hi" }] }, ASK);
	assert.deepEqual(plain.messages, [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "text", text: ASK }] }]);
});

test("openai-responses: one more input message", () => {
	const payload = {
		model: "gpt",
		input: [
			{ role: "developer", content: "SYSTEM" },
			{ role: "user", content: [{ type: "input_text", text: "hi" }] },
			{ type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
			{ type: "function_call_output", call_id: "c1", output: "body" },
		],
		tools: [],
		prompt_cache_key: "session-1",
		reasoning: { effort: "high" },
		stream: true,
	};
	const before = structuredClone(payload);
	const out = fork.buildForkPayload("openai-responses", payload, ASK);
	assert.deepEqual(payload, before);
	assert.deepEqual(out.input.slice(0, -1), payload.input);
	assert.deepEqual(out.input.at(-1), { role: "user", content: [{ type: "input_text", text: ASK }] });
	assert.equal(out.prompt_cache_key, "session-1");
});

test("an unknown API, or a payload without the conversation, cannot be forked", () => {
	assert.equal(fork.buildForkPayload("google-generative-ai", { contents: [] }, ASK), undefined);
	assert.equal(fork.buildForkPayload("openai-completions", { model: "m" }, ASK), undefined);
	assert.equal(fork.buildForkPayload("openai-completions", { model: "m", messages: [] }, ASK), undefined);
	assert.equal(fork.buildForkPayload("openai-responses", { model: "m", messages: [] }, ASK), undefined);
	assert.equal(fork.buildForkPayload("anthropic-messages", null, ASK), undefined);
	assert.deepEqual([...fork.FORKABLE_APIS].sort(), ["anthropic-messages", "openai-completions", "openai-responses"]);
});

function fakeCtx(response, seen = {}) {
	return {
		model: { provider: "p", id: "m", api: "openai-completions" },
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry: {
			async complete(model, context, options) {
				seen.model = model;
				seen.context = context;
				seen.options = options;
				if (response instanceof Error) throw response;
				seen.sent = await options.onPayload?.({ placeholder: true }, model);
				return response;
			},
		},
	};
}

test("requestFork sends the fork payload in place of the stub request", async () => {
	const seen = {};
	const forked = { model: "m", messages: [{ role: "user", content: ASK }] };
	const signal = new AbortController().signal;
	const result = await fork.requestFork(
		fakeCtx({ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "<summary>S</summary>" }], usage: { input: 1, cacheRead: 99 } }, seen),
		forked,
		signal,
	);
	assert.deepEqual(seen.sent, forked, "the provider sends the fork, not the stub");
	assert.equal(seen.options.signal, signal);
	assert.equal(seen.options.sessionId, "session-1", "the live session id, so routing and cache keys match");
	assert.deepEqual(result, { ok: true, reply: "<summary>S</summary>", usage: { input: 1, cacheRead: 99 }, stopReason: "stop" });
});

test("requestFork: a capped reply is still a summary; errors, empty replies and throws are not", async () => {
	const capped = await fork.requestFork(fakeCtx({ stopReason: "length", content: [{ type: "text", text: "<analysis>cut" }], usage: {} }), { messages: [] }, undefined);
	assert.equal(capped.ok, true, "Claude Code keeps a reply cut off by the output cap");
	const error = await fork.requestFork(fakeCtx({ stopReason: "error", errorMessage: "prompt is too long", content: [] }), { messages: [] }, undefined);
	assert.deepEqual(error, { ok: false, reason: "prompt is too long" });
	const empty = await fork.requestFork(fakeCtx({ stopReason: "stop", content: [{ type: "text", text: "  " }] }), { messages: [] }, undefined);
	assert.deepEqual(empty, { ok: false, reason: "empty reply" });
	const thrown = await fork.requestFork(fakeCtx(new Error("no api key")), { messages: [] }, undefined);
	assert.deepEqual(thrown, { ok: false, reason: "no api key" });
	const ignored = await fork.requestFork(
		{
			model: {},
			sessionManager: { getSessionId: () => "s" },
			modelRegistry: { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "x" }] }) },
		},
		{ messages: [] },
		undefined,
	);
	assert.deepEqual(ignored, { ok: false, reason: "the provider did not apply the payload rewrite" });
});
