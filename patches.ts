/**
 * The two places pi-cc-compact reaches into Pi, and the state they share.
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
 *    The wrapper also remembers Pi's live settings object, the only way to
 *    change cacheWarming in memory as well as in settings.json.
 *
 * 2. ExtensionRunner.prototype.emitBeforeProviderRequest. Every ordinary
 *    request passes through it on its way to the provider, after all the
 *    before_provider_request handlers ran. The final payload is kept per
 *    session: the fork request (fork.ts) is that payload plus one turn, and
 *    it only reads the cache if every byte before the turn matches. Capturing
 *    here, not in a handler of our own, sees the changes of extensions that
 *    load after this one (cache-sticky's metadata.user_id, say).
 *
 * Both are wrapped once per process, however often the extension loads
 * (/reload runs it again): the wrappers read the current behaviour from a
 * runtime object on a global symbol, which every load of this module shares.
 */

/** A model, as far as the reserve needs it. */
export interface ModelLike {
	provider?: string;
	id?: string;
	maxTokens?: number;
}

export interface Capture {
	/** The request body as the provider received it. */
	payload: Record<string, unknown>;
	/** The session's last entry when the request was built: what the request covers. */
	leafId: string | null;
	/** When the request was sent, ms since the epoch. */
	at: number;
}

/** Pi's SettingsManager, as far as pi-cc-compact uses it. */
export interface SettingsLike {
	getCompactionSettings(model?: unknown): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	getCacheWarmingMode?(): string;
	setCacheWarmingMode?(mode: string | undefined): void;
	flush?(): Promise<void>;
}

export type CompactionOverride = (model: ModelLike | undefined) => { keepRecentTokens?: number; reserveTokens?: number } | undefined;

export interface CompactRuntime {
	/** The last ordinary request of each session. */
	captures: Map<string, Capture>;
	/** Pi's live settings object, once Pi has asked it for compaction settings. */
	settings: SettingsLike | undefined;
	/** The settings to answer with; undefined leaves Pi's own. Set by the latest load. */
	override: CompactionOverride | undefined;
}

const RUNTIME = Symbol.for("pi-cc-compact:runtime");
const WRAPPED = Symbol.for("pi-cc-compact:wrapped");

/** The state shared by every load of the extension in this process. */
export function runtime(): CompactRuntime {
	const holder = globalThis as typeof globalThis & Record<symbol, CompactRuntime | undefined>;
	holder[RUNTIME] ??= { captures: new Map(), settings: undefined, override: undefined };
	return holder[RUNTIME];
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
 * missing, that half of pi-cc-compact stays inert and Pi behaves as without it.
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
					rt.captures.set(sessionId, {
						payload: structuredClone(result),
						leafId: this.sessionManager?.getLeafId?.() ?? null,
						at: Date.now(),
					});
				}
			} catch {
				// Capturing must never break a request; without it the fallback summarizes.
			}
			return result;
		} as Wrappable;
		wrapped[WRAPPED] = true;
		runnerProto!.emitBeforeProviderRequest = wrapped;
	}

	return { missing };
}
