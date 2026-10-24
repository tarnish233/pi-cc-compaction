/**
 * The compaction itself: session_before_compact, for /compact, Pi's
 * automatic threshold and overflow recovery alike.
 *
 * pi-cc-compact takes a compaction when it can read the prompt cache
 * (plan.ts): the last answered request of this session is forked (fork.ts),
 * so the summary costs a summary, not a re-read of the conversation. When no
 * cache can be read (nothing answered yet, another model, an expired cache,
 * an API that cannot be forked), Pi's own compaction runs, with Pi's own
 * settings, and the user is told why once.
 *
 * What is kept verbatim. Claude Code keeps the last API round and summarizes
 * the rest. Here that round is whatever followed the forked request: its
 * reply and anything after (tool results, the next prompt, the input that
 * overflowed). Claude Code says so in the summary: the kept messages were
 * not seen by it. Overflow recovery needs nothing else: the request that
 * overflowed never got a reply, so the fork is the one before it, which
 * fitted the window and whose cache is warm.
 *
 * Failures are Claude Code's (2.1.308): a compaction that fails is
 * cancelled, never handed to another algorithm. Transient errors are retried
 * first, with Pi's retry settings. /compact shows Claude Code's message;
 * automatic compaction counts the failure, and three in a row, or three
 * rapid refills in a row, stop it for the session (breaker.ts). A
 * conversation of fewer than two rounds has nothing to compact.
 *
 * A reply cut off by the output cap is used, as Claude Code uses it. The
 * stored summary is Claude Code's summary message (prompt.ts) followed by
 * the files it would re-read (restore.ts).
 */

import type { ExtensionContext, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import * as breaker from "./breaker.ts";
import type { PiCcConfig } from "./config.ts";
import { buildForkPayload, forkWithRetry, type RetryPolicy } from "./fork.ts";
import { runtime } from "./patches.ts";
import { forkPlan } from "./plan.ts";
import { summaryMessage, summaryRequest } from "./prompt.ts";
import { recentFiles, restoreBlocks } from "./restore.ts";

/** Claude Code's messages. */
export const NOT_ENOUGH_MESSAGES = "Not enough messages to compact.";
export const COULD_NOT_REDUCE = "Compaction failed \u00b7 conversation could not be reduced below the context limit";
export const ERROR_PREFIX = "Error during compaction: ";
export const THRASHING =
	"Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window. Try reading in smaller chunks, or use /clear to start fresh.";
export const BREAKER_TRIPPED = "Auto-compaction failed 3 times in a row \u00b7 skipping it for the rest of this session (/compact still works)";

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
	engine: "fork";
	stopReason: string;
	/** Fork attempts, retries included. */
	attempts: number;
	restoredFiles: string[];
}

export interface CompactDeps {
	now?: () => number;
	/** The retry policy; Pi's retry settings by default. */
	retry?: RetryPolicy;
}

type Ctx = Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager" | "cwd" | "hasUI" | "ui">;

/** "Pi's own compaction ran" is told once per session and reason. */
const told = new Set<string>();

/** Forget which notices were given (tests). */
export function resetNotices(): void {
	told.clear();
}

function notify(ctx: Ctx, message: string, level: "info" | "warning" | "error"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	} catch {
		// a stale context must never break compaction
	}
}

/** Pi's retry settings (retry.enabled, maxRetries, baseDelayMs), from its live settings object when known. */
function piRetryPolicy(): RetryPolicy {
	const settings = (runtime().settings as { getRetrySettings?: () => { enabled?: boolean; maxRetries?: number; baseDelayMs?: number } } | undefined)?.getRetrySettings?.();
	return {
		maxRetries: settings?.enabled === false ? 0 : (settings?.maxRetries ?? 3),
		baseDelayMs: settings?.baseDelayMs ?? 2000,
	};
}

/** Cancel a compaction the way Claude Code reports a failure. */
function fail(ctx: Ctx, sessionId: string, reason: string, message: string): SessionBeforeCompactResult {
	if (reason === "manual") {
		notify(ctx, message, "error");
	} else {
		notify(ctx, `Auto-compaction failed: ${message}`, "warning");
		if (breaker.noteFailure(sessionId)) notify(ctx, BREAKER_TRIPPED, "warning");
	}
	return { cancel: true };
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

/**
 * The session_before_compact handler: the compaction to store, a cancel, or
 * undefined to let Pi compact (Claude Code's compaction off, or no cache to read).
 */
export async function handleCompaction(
	event: CompactEventLike,
	ctx: Ctx,
	config: Pick<PiCcConfig, "compaction">,
	deps: CompactDeps = {},
): Promise<SessionBeforeCompactResult | undefined> {
	if (!config.compaction || !ctx.model) return undefined;
	const sessionId = ctx.sessionManager.getSessionId();
	const reason = event.reason ?? "manual";
	if (reason !== "manual" && breaker.isOpen(sessionId)) return { cancel: true };
	if (reason === "threshold" && breaker.noteAutoCompaction(sessionId)) {
		notify(ctx, THRASHING, "warning");
		return { cancel: true };
	}

	const plan = forkPlan(sessionId, ctx.model as { provider?: string; id?: string; api?: string }, (deps.now ?? Date.now)());
	const branch = event.branchEntries ?? (ctx.sessionManager.getBranch() as EntryLike[]);
	const leafIndex = plan.ok ? branch.findIndex((entry) => entry.id === plan.capture.leafId) : -1;
	// No cache can be read: Pi's own compaction runs, with Pi's own settings,
	// and the reason is said once.
	if (!plan.ok) {
		const key = `${sessionId}\u0000${plan.reason}`;
		if (!told.has(key)) {
			told.add(key);
			notify(ctx, `pi-cc-compact: ${plan.reason} \u00b7 Pi's own compaction ran`, "info");
		}
		return undefined;
	}
	// The captured request cannot be matched to this branch (a fork away): Pi
	// would compact with the keepRecentTokens:1 the settings patch already
	// answered with, keeping one message - so this is cancelled instead.
	if (leafIndex === -1 || branch.slice(leafIndex + 1).some((entry) => entry.type === "compaction")) {
		notify(ctx, "pi-cc-compact: the last answered request is not on this branch \u00b7 the compaction was cancelled", "warning");
		return { cancel: true };
	}

	const projected = ctx.sessionManager.buildSessionProjection().entries as unknown as ProjectedEntry[];
	const firstKeptEntryId = branch[leafIndex + 1]?.id ?? null;
	const keptAt = firstKeptEntryId === null ? -1 : projected.findIndex((entry) => entry.sourceEntry.id === firstKeptEntryId);
	const summarized = (keptAt === -1 ? projected : projected.slice(0, keptAt)).flatMap((entry) => entry.messages) as MessageLike[];
	const kept = (keptAt === -1 ? [] : projected.slice(keptAt)).flatMap((entry) => entry.messages) as MessageLike[];

	// Claude Code compacts two rounds or more: one assistant response is a round.
	const rounds = [...summarized, ...kept].filter((message) => message.role === "assistant").length;
	if (rounds < 2) return fail(ctx, sessionId, reason, NOT_ENOUGH_MESSAGES);

	const ask = summaryRequest(event.customInstructions);
	const payload = buildForkPayload((ctx.model as { api: string }).api, plan.capture.payload, ask);
	if (!payload) return fail(ctx, sessionId, reason, `${ERROR_PREFIX}the request could not be extended`);
	const result = await forkWithRetry(ctx, payload, event.signal, deps.retry ?? piRetryPolicy());
	if (event.signal?.aborted) return { cancel: true };
	if (!result.ok) return fail(ctx, sessionId, reason, result.overflow ? COULD_NOT_REDUCE : `${ERROR_PREFIX}${result.reason}`);

	const restoredFiles = recentFiles([...summarized, ...kept] as never, kept as never, ctx.cwd);
	const summary = summaryMessage({
		reply: result.reply,
		toolNames: toolNamesOf([...summarized, ...kept]),
		transcriptPath: ctx.sessionManager.getSessionFile() ?? undefined,
		keptMessages: kept.length > 0,
		restored: restoreBlocks(restoredFiles),
	});
	const details: CompactionDetails = { engine: "fork", stopReason: result.stopReason, attempts: result.attempts, restoredFiles };
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
