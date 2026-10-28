/**
 * The provider and settings hooks pi-cc-compaction uses, plus SDK cleanup.
 *
 * 1. SettingsManager.prototype.getCompactionSettings. Pi reads its compaction
 *    settings through this one method, before every threshold check and
 *    before every compaction. While Claude Code's compaction is on, the
 *    answer carries Claude Code's numbers instead of Pi's:
 *      - reserveTokens = min(output cap, 20K) + 13K, so automatic compaction
 *        starts where Claude Code's does (window - 33K for most models);
 *      - keepRecentTokens = 1, so Pi's "Nothing to compact" gate (it wants
 *        20K tokens of history before it asks extensions) never keeps a
 *        compaction from reaching this extension. Claude Code compacts any
 *        conversation of two rounds or more; what stays verbatim is decided
 *        here, not by Pi.
 *    The wrapper also remembers Pi's live settings object, where the fork's
 *    retries read Pi's retry settings.
 *
 * 2. ExtensionRunner.prototype.emitBeforeProviderRequest. Every ordinary
 *    request passes through it on its way to the provider, after all the
 *    before_provider_request handlers ran. The fork request (fork.ts) is such
 *    a request plus one turn, and it only reads the cache if every byte
 *    before the turn matches, so the final payload is held per session.
 *    Holding it here, not in a handler of our own, sees the changes of
 *    extensions that load after this one (cache-sticky's metadata.user_id).
 *
 *    The payload is held by reference, not copied: Pi builds a new request
 *    object for every request, sets its cache markers before the extensions
 *    see it, and neither Pi nor the provider SDKs change it once it is sent
 *    (checked in the code of Pi 1.3.0 and 1.4.0, and live on all three APIs).
 *    It is held as the request in flight first; only when its reply arrives
 *    (turn_end, commitPending) does it become the request to fork. A request
 *    that fails, an overflow say, never wrote the cache, so the last request
 *    that succeeded stays the one to fork.
 *
 * 3. ExtensionRunner.invalidate cleans up sessions that an SDK caller ends
 *    with session.dispose(), which emits no session_shutdown. A Pi reload
 *    already removes the active session before invalidation, so its cached
 *    request and breaker survive the reload.
 *
 * All are wrapped once per process, however often the extension loads
 * (/reload runs it again): the wrappers read the current behaviour from a
 * runtime object on a global symbol, which every load of this module shares.
 */

import * as breaker from "./breaker.ts";

/** A model, as far as the reserve needs it. */
export interface ModelLike {
	provider?: string;
	id?: string;
	api?: string;
	maxTokens?: number;
}

export interface Capture {
	/** The request body as the provider received it (Pi's own object). */
	payload: Record<string, unknown>;
	/** The session's last entry when the request was built: what the request covers. */
	leafId: string | null;
	/** When the request was sent, ms since the epoch. */
	at: number;
	/** How long the provider keeps the cache this request wrote, when the model declares it. */
	ttlMs?: number;
	/** provider/model the reply came from: a cache belongs to one model on one provider. */
	modelKey?: string;
}

/** Pi's SettingsManager, as far as pi-cc-compaction uses it. */
export interface SettingsLike {
	getCompactionSettings(model?: unknown): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	getRetrySettings?(): { enabled?: boolean; maxRetries?: number; baseDelayMs?: number };
}

export type CompactionOverride = (
	model: ModelLike | undefined,
) => { enabled?: boolean; keepRecentTokens?: number; reserveTokens?: number } | undefined;

export interface CompactRuntime {
	/** The request in flight of each session, not yet answered. */
	pending: Map<string, Capture>;
	/** The last request of each session that got a reply: the one to fork. */
	captures: Map<string, Capture>;
	/** No settings call identifies its session; with several SDK sessions, fall back to Pi. */
	activeSessions: Map<string, CompactionOverride>;
	/** The only live session whose settings can safely be overridden. */
	activeSessionId: string | undefined;
	/** Pi's live settings object, once Pi has asked it for compaction settings. */
	settings: SettingsLike | undefined;
	/** The settings to answer with; undefined leaves Pi's own. Set by the latest load. */
	override: CompactionOverride | undefined;
}

const RUNTIME = Symbol.for("pi-cc-compaction:runtime");
const WRAPPED = Symbol.for("pi-cc-compaction:wrapped");

/** The state shared by every load of the extension in this process. */
export function runtime(): CompactRuntime {
	const holder = globalThis as typeof globalThis & Record<symbol, CompactRuntime | undefined>;
	holder[RUNTIME] ??= { pending: new Map(), captures: new Map(), activeSessions: new Map(), activeSessionId: undefined, settings: undefined, override: undefined };
	// A reload can encounter the process-level runtime from an older version.
	holder[RUNTIME].activeSessions ??= new Map();
	return holder[RUNTIME];
}

/** SettingsManager has no session ID: override it only while one extension session is live. */
export function syncLiveSessions(): void {
	const rt = runtime();
	const sessions = [...rt.activeSessions.entries()];
	rt.activeSessionId = sessions.length === 1 ? sessions[0][0] : undefined;
	rt.override = sessions.length === 1 ? sessions[0][1] : undefined;
}

/** The request in flight got its reply: it becomes the one to fork. False when nothing was in flight. */
export function commitPending(sessionId: string, extra: Pick<Capture, "ttlMs" | "modelKey"> = {}): boolean {
	const rt = runtime();
	const pending = rt.pending.get(sessionId);
	if (!pending) return false;
	rt.pending.delete(sessionId);
	const known = Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined));
	rt.captures.set(sessionId, { ...pending, ...known });
	return true;
}

/** Drop what a session holds: its prefix no longer leads where the conversation goes (compacted, another branch, ended). */
export function forgetSession(sessionId: string): void {
	const rt = runtime();
	rt.pending.delete(sessionId);
	rt.captures.delete(sessionId);
}

/** Claude Code's output reserve for the auto-compact threshold: min(output cap, 20K), plus its 13K buffer. */
export function ccReserveTokens(model: ModelLike | undefined): number {
	const cap = typeof model?.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : 20000;
	return Math.min(cap, 20000) + 13000;
}

/** Pi's cache warmer replays the last request with a one-token output cap; such a replay is not a request to fork. */
export function isWarmReplay(payload: Record<string, unknown>): boolean {
	return payload.max_tokens === 1 || payload.max_completion_tokens === 1 || payload.max_output_tokens === 1;
}

function holdsConversation(payload: unknown): payload is Record<string, unknown> {
	if (typeof payload !== "object" || payload === null) return false;
	const record = payload as Record<string, unknown>;
	return Array.isArray(record.messages) || Array.isArray(record.input);
}

/** Pi's classes, as the extension imports them (their constructors may be private). */
interface Classes {
	SettingsManager?: unknown;
	ExtensionRunner?: unknown;
}

type Wrappable = ((...args: never[]) => unknown) & { [WRAPPED]?: true };

/**
 * Wrap the two methods, once. Returns the methods this Pi lacks; with either
 * missing, that half of pi-cc-compaction stays inert and Pi behaves as without it.
 */
export function installPatches(classes: Classes): { missing: string[] } {
	const missing: string[] = [];
	const rt = runtime();

	const settingsProto = (classes.SettingsManager as { prototype?: Record<string, unknown> } | undefined)?.prototype;
	const getSettings = settingsProto?.getCompactionSettings as Wrappable | undefined;
	if (typeof getSettings !== "function") {
		missing.push("SettingsManager.getCompactionSettings");
	} else if (!getSettings[WRAPPED]) {
		const wrapped: Wrappable = function (this: SettingsLike, model?: ModelLike) {
			const base = (getSettings as unknown as SettingsLike["getCompactionSettings"]).call(this, model);
			rt.settings = this;
			const override = rt.override?.(model);
			return override ? { ...base, ...override } : base;
		} as Wrappable;
		wrapped[WRAPPED] = true;
		settingsProto!.getCompactionSettings = wrapped;
	}

	const runnerProto = (classes.ExtensionRunner as { prototype?: Record<string, unknown> } | undefined)?.prototype;
	const emit = runnerProto?.emitBeforeProviderRequest as Wrappable | undefined;
	if (typeof emit !== "function") {
		missing.push("ExtensionRunner.emitBeforeProviderRequest");
	} else if (!emit[WRAPPED]) {
		const wrapped: Wrappable = async function (this: { sessionManager?: { getSessionId?(): string; getLeafId?(): string | null } }, payload: unknown) {
			const result = await (emit as unknown as (payload: unknown) => Promise<unknown>).call(this, payload);
			try {
				const sessionId = this.sessionManager?.getSessionId?.();
				if (sessionId && holdsConversation(result) && !isWarmReplay(result)) {
					rt.pending.set(sessionId, { payload: result, leafId: this.sessionManager?.getLeafId?.() ?? null, at: Date.now() });
				}
			} catch {
				// Capturing must never break a request; without it the fallback summarizes.
			}
			return result;
		} as Wrappable;
		wrapped[WRAPPED] = true;
		runnerProto!.emitBeforeProviderRequest = wrapped;
	}

	// SDK callers dispose() without emitting session_shutdown. Invalidation is
	// their guaranteed cleanup point; a Pi reload already removed its entry in
	// session_shutdown, so the answered request is still kept across reloads.
	const invalidate = runnerProto?.invalidate as Wrappable | undefined;
	if (typeof invalidate === "function" && !invalidate[WRAPPED]) {
		const wrapped: Wrappable = function (this: { sessionManager?: { getSessionId?(): string } }, ...args: never[]) {
			const sessionId = this.sessionManager?.getSessionId?.();
			try {
				return invalidate.apply(this, args);
			} finally {
				if (sessionId && rt.activeSessions.delete(sessionId)) {
					syncLiveSessions();
					forgetSession(sessionId);
					breaker.reset(sessionId);
					rt.settings = undefined;
				}
			}
		} as Wrappable;
		wrapped[WRAPPED] = true;
		runnerProto!.invalidate = wrapped;
	}

	return { missing };
}
