/**
 * The compaction itself: session_before_compact, for /compact, Pi's
 * automatic threshold and overflow recovery alike.
 *
 * What is kept verbatim. Claude Code keeps the last API round and summarizes
 * the rest. Here that round is whatever followed the last captured request:
 * the reply to it and anything after (tool results, the user's next prompt).
 * Claude Code says so in the summary: the kept messages were not seen by it.
 * Without a usable capture the last assistant message and what follows it are
 * kept, the same round found from the session instead. A round that alone
 * reaches the auto-compact threshold (a huge tool result in a small window)
 * is summarized as well, and nothing is kept: keeping it would leave the
 * context over the threshold, compacting again on every turn.
 *
 * How the summary is asked for, in order:
 *  1. The fork (fork.ts): the captured request plus Claude Code's ask. It
 *     reads the prompt cache, so a compaction costs a summary, not a re-read
 *     of the conversation. Used when the capture is of the current model,
 *     on a forkable API, still on the branch and not yet compacted. Not for
 *     overflow recovery: the captured request is the one that overflowed.
 *  2. The summary request, Claude Code's fallback: its summarizer system
 *     prompt, and the conversation sent as text with tool results cut to
 *     2,000 characters (Pi's serialization), so it fits where the fork did
 *     not. Same model, same thinking level.
 *  3. Pi's own compaction, when both fail; the user is told once.
 *
 * A reply cut off by the output cap is used, as Claude Code uses it. The
 * stored summary is Claude Code's summary message (prompt.ts) followed by the
 * files it would re-read (restore.ts).
 */

import { convertToLlm, estimateTokens, serializeConversation, type ExtensionContext, type SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import type { PiCcConfig } from "./config.ts";
import { FORKABLE_APIS, buildForkPayload, interpretReply, requestFork, type ForkResult } from "./fork.ts";
import { ccReserveTokens, runtime, type Capture } from "./patches.ts";
import { DEDICATED_SYSTEM_PROMPT, summaryMessage, summaryRequest } from "./prompt.ts";
import { recentFiles, restoreBlocks } from "./restore.ts";

interface EntryLike {
	id: string;
	type: string;
	message?: { role?: string };
}

interface ProjectedEntry {
	sourceEntry: EntryLike;
	messages: unknown[];
}

interface MessageLike {
	role?: string;
	content?: unknown;
	summary?: unknown;
}

export interface CompactEventLike {
	preparation: { tokensBefore: number };
	branchEntries?: EntryLike[];
	customInstructions?: string;
	reason?: string;
	signal?: AbortSignal;
}

export interface CompactionDetails {
	/** Which request wrote the summary. */
	engine: "fork" | "summary-request";
	stopReason: string;
	/** Why the fork was not used, when it was not. */
	forkSkipped?: string;
	restoredFiles: string[];
}

type Ctx = Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager" | "cwd" | "hasUI" | "ui"> & { thinkingLevel?: string };

/** One "Pi's own compaction ran" notice per session. */
const toldFallback = new Set<string>();

function notify(ctx: Ctx, message: string, level: "info" | "warning"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	} catch {
		// a stale context must never break compaction
	}
}

/** The capture, if it can be forked for this model and branch; otherwise why not. */
function usableCapture(ctx: Ctx, branch: EntryLike[], reason: string | undefined): { capture: Capture; leafIndex: number } | string {
	const capture = runtime().captures.get(ctx.sessionManager.getSessionId());
	if (!capture) return "no request captured yet";
	if (reason === "overflow") return "the captured request overflowed";
	const model = ctx.model as { id?: string; api?: string } | undefined;
	if (!model?.api || !FORKABLE_APIS.has(model.api)) return `${model?.api ?? "this"} API cannot be forked`;
	if (capture.payload.model !== model.id) return "the captured request is of another model";
	const leafIndex = branch.findIndex((entry) => entry.id === capture.leafId);
	if (leafIndex === -1) return "the captured request is not on this branch";
	if (branch.slice(leafIndex + 1).some((entry) => entry.type === "compaction")) return "the captured request was compacted already";
	return { capture, leafIndex };
}

/** Claude Code keeps the last API round: the last assistant message and what follows it. */
function lastRoundStart(projected: ProjectedEntry[]): string | null {
	for (let i = projected.length - 1; i >= 0; i--) {
		if (projected[i].messages.some((message) => (message as MessageLike)?.role === "assistant")) return projected[i].sourceEntry.id;
	}
	return null;
}

/** Whether the messages to keep would by themselves leave the context at Claude Code's threshold. */
function keptFillsThreshold(model: { contextWindow?: number; maxTokens?: number } | undefined, kept: MessageLike[]): boolean {
	const window = model?.contextWindow;
	if (typeof window !== "number" || window <= 0) return false;
	const threshold = window - ccReserveTokens(model);
	if (threshold <= 0) return false;
	let tokens = 0;
	for (const message of kept) tokens += estimateTokens(message as never);
	return tokens >= threshold;
}

const TOOLS_TAG = /<tools-used-before-summary>([^<]*)<\/tools-used-before-summary>/;

function textOf(message: MessageLike): string {
	if (typeof message.summary === "string") return message.summary;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return (message.content as Array<{ type?: string; text?: string }>)
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Tools the conversation called, including those an earlier summary listed (Claude Code carries them over). */
function toolNamesOf(messages: MessageLike[]): string[] {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as Array<{ type?: string; name?: string }>) {
				if (block?.type === "toolCall" && typeof block.name === "string" && block.name.trim()) names.add(block.name.trim());
			}
		}
		const listed = TOOLS_TAG.exec(textOf(message))?.[1];
		if (listed) for (const name of listed.split(",")) if (name.trim()) names.add(name.trim());
	}
	return [...names].sort();
}

async function requestSummary(ctx: Ctx, summarized: MessageLike[], ask: string, signal: AbortSignal | undefined): Promise<ForkResult> {
	if (summarized.length === 0) return { ok: false, reason: "nothing to summarize" };
	const conversation = serializeConversation(convertToLlm(summarized as never));
	const model = ctx.model as { reasoning?: boolean } | undefined;
	const level = ctx.thinkingLevel;
	try {
		const stream = ctx.modelRegistry.streamSimple(
			ctx.model as never,
			{
				systemPrompt: DEDICATED_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: `<conversation>\n${conversation}\n</conversation>\n\n${ask}` }], timestamp: Date.now() }],
			} as never,
			{ signal, sessionId: ctx.sessionManager.getSessionId(), ...(model?.reasoning && level && level !== "off" ? { reasoning: level } : {}) } as never,
		);
		return interpretReply(await stream.result());
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The session_before_compact handler. Returns the compaction to store, or
 * undefined to let Pi compact (with Claude Code's compaction off, or when
 * neither request produced a summary).
 */
export async function handleCompaction(event: CompactEventLike, ctx: Ctx, config: Pick<PiCcConfig, "compaction">): Promise<SessionBeforeCompactResult | undefined> {
	if (!config.compaction || !ctx.model) return undefined;
	const branch = event.branchEntries ?? (ctx.sessionManager.getBranch() as EntryLike[]);
	const projected = ctx.sessionManager.buildSessionProjection().entries as unknown as ProjectedEntry[];

	let usable = usableCapture(ctx, branch, event.reason);
	let firstKeptEntryId = typeof usable === "string" ? lastRoundStart(projected) : (branch[usable.leafIndex + 1]?.id ?? null);
	let keptAt = firstKeptEntryId === null ? -1 : projected.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	let kept = (keptAt === -1 ? [] : projected.slice(keptAt)).flatMap((entry) => entry.messages) as MessageLike[];
	if (kept.length > 0 && keptFillsThreshold(ctx.model as { contextWindow?: number; maxTokens?: number }, kept)) {
		// The fork cannot summarize a round its request never carried: the summary request does.
		usable = "the kept round alone reaches the compaction threshold";
		firstKeptEntryId = null;
		keptAt = -1;
		kept = [];
	}
	const summarized = (keptAt === -1 ? projected : projected.slice(0, keptAt)).flatMap((entry) => entry.messages) as MessageLike[];

	const ask = summaryRequest(event.customInstructions);
	let engine: CompactionDetails["engine"] = "fork";
	let result: ForkResult | undefined;
	let forkSkipped: string | undefined;
	if (typeof usable === "string") {
		forkSkipped = usable;
	} else {
		const payload = buildForkPayload((ctx.model as { api: string }).api, usable.capture.payload, ask);
		result = payload ? await requestFork(ctx, payload, event.signal) : { ok: false, reason: "the request could not be extended" };
		if (!result.ok) forkSkipped = result.reason;
	}
	if (event.signal?.aborted) return undefined;
	if (!result?.ok) {
		engine = "summary-request";
		result = await requestSummary(ctx, summarized, ask, event.signal);
	}
	if (event.signal?.aborted) return undefined;
	if (!result.ok) {
		const key = ctx.sessionManager.getSessionId();
		if (!toldFallback.has(key)) {
			toldFallback.add(key);
			notify(ctx, `pi-cc-compact: the summary failed (${result.reason}); Pi's own compaction ran instead`, "warning");
		}
		return undefined;
	}

	const restoredFiles = recentFiles([...summarized, ...kept] as never, kept as never, ctx.cwd);
	const summary = summaryMessage({
		reply: result.reply,
		toolNames: toolNamesOf([...summarized, ...kept]),
		transcriptPath: ctx.sessionManager.getSessionFile() ?? undefined,
		keptMessages: kept.length > 0,
		restored: restoreBlocks(restoredFiles),
	});
	const details: CompactionDetails = { engine, stopReason: result.stopReason, restoredFiles, ...(forkSkipped ? { forkSkipped } : {}) };
	return {
		compaction: {
			summary,
			// null: Pi records a compaction that keeps nothing before it (appendCompaction
			// stores the compaction's own id); the hook's type says string only.
			firstKeptEntryId: firstKeptEntryId as string,
			tokensBefore: event.preparation.tokensBefore,
			usage: result.usage as NonNullable<SessionBeforeCompactResult["compaction"]>["usage"],
			details,
		},
	};
}
