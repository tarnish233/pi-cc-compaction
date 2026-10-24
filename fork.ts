/**
 * The fork request: Claude Code's way of asking for a summary.
 *
 * Claude Code summarizes by forking the session: the same system prompt,
 * tools, messages and thinking settings, with one user turn appended that
 * asks for the summary. The provider has already cached that prefix, so the
 * summary request reads it instead of paying for the conversation again. Its
 * cache marker stays where the last ordinary request put it, so the fork reads
 * the cache and writes nothing new (Claude Code's skipCacheWrite).
 *
 * Here the fork is built from the last ordinary request exactly as the
 * provider received it (see capture.ts) and sent through Pi's own provider
 * code: modelRegistry.complete() builds a request for a stub context, and the
 * onPayload hook swaps in the fork before it goes out. Authentication,
 * headers, routing and streaming stay Pi's.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The provider APIs whose request bodies can be extended by one user turn. */
export const FORKABLE_APIS: ReadonlySet<string> = new Set(["anthropic-messages", "openai-completions", "openai-responses"]);

type Payload = Record<string, unknown>;

function isPayload(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function forkAnthropic(payload: Payload, ask: string): Payload | undefined {
	const messages = payload.messages;
	if (!Array.isArray(messages) || messages.length === 0) return undefined;
	const askBlock = { type: "text", text: ask };
	const last = messages[messages.length - 1] as { role?: string; content?: unknown };
	if (last?.role !== "user") return { ...payload, messages: [...messages, { role: "user", content: [askBlock] }] };
	// Consecutive user turns are merged by the API anyway; joining the last one
	// keeps its cache marker on the block it was written on, ahead of the ask.
	const content = Array.isArray(last.content) ? [...last.content, askBlock] : [{ type: "text", text: String(last.content ?? "") }, askBlock];
	return { ...payload, messages: [...messages.slice(0, -1), { ...last, content }] };
}

function forkChat(payload: Payload, ask: string): Payload | undefined {
	const messages = payload.messages;
	if (!Array.isArray(messages) || messages.length === 0) return undefined;
	return { ...payload, messages: [...messages, { role: "user", content: ask }] };
}

function forkResponses(payload: Payload, ask: string): Payload | undefined {
	const input = payload.input;
	if (!Array.isArray(input) || input.length === 0) return undefined;
	return { ...payload, input: [...input, { role: "user", content: [{ type: "input_text", text: ask }] }] };
}

/**
 * The live request with the summary ask appended, or undefined when the API
 * is not one this knows how to extend. Nothing in the live request changes:
 * a different byte anywhere before the ask would miss the cache.
 */
export function buildForkPayload(api: string, payload: unknown, ask: string): Payload | undefined {
	if (!isPayload(payload)) return undefined;
	switch (api) {
		case "anthropic-messages":
			return forkAnthropic(payload, ask);
		case "openai-completions":
			return forkChat(payload, ask);
		case "openai-responses":
			return forkResponses(payload, ask);
		default:
			return undefined;
	}
}

export type ForkResult =
	| { ok: true; reply: string; usage: unknown; stopReason: string }
	| { ok: false; reason: string };

/** A provider reply, as far as a summary needs it. */
export interface ReplyLike {
	stopReason?: string;
	errorMessage?: string;
	content?: Array<{ type: string; text?: string }>;
	usage?: unknown;
}

/**
 * Read a summary reply. A reply cut off by the output cap is kept, as Claude
 * Code keeps it; an error, an abort or an empty reply is a failure.
 */
export function interpretReply(response: ReplyLike): ForkResult {
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return { ok: false, reason: response.errorMessage ?? response.stopReason };
	}
	const reply = (response.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (!reply) return { ok: false, reason: "empty reply" };
	return { ok: true, reply, usage: response.usage, stopReason: response.stopReason ?? "stop" };
}

/** A request Pi's provider code can build; its body is replaced before sending. */
const STUB_CONTEXT = {
	systemPrompt: "Summarize.",
	messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Summarize." }], timestamp: 0 }],
};

/**
 * Send the fork through Pi's provider for the current model. Besides what
 * interpretReply rejects, a provider that ignored the rewrite is a failure
 * the caller falls back from.
 */
export async function requestFork(ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">, payload: Payload, signal: AbortSignal | undefined): Promise<ForkResult> {
	let applied = false;
	let response: ReplyLike;
	try {
		response = (await ctx.modelRegistry.complete(ctx.model as never, STUB_CONTEXT as never, {
			signal,
			sessionId: ctx.sessionManager.getSessionId(),
			onPayload: () => {
				applied = true;
				return payload;
			},
		} as never)) as typeof response;
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
	if (!applied) return { ok: false, reason: "the provider did not apply the payload rewrite" };
	return interpretReply(response);
}
