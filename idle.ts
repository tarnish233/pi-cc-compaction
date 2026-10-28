/**
 * Idle compaction: compact while the user is away, before the prompt cache
 * expires.
 *
 * A compaction reads the cached prefix (the fork in fork.ts), so it is cheap
 * while the cache is warm. Once the cache has expired, the next request pays
 * for the whole conversation again. Claude Code (2.1.308, behind its
 * tengu_sunny_locket flag) therefore compacts a large conversation when the
 * user has been idle for 90% of a one-hour cache lifetime, and only for
 * one-hour caches: on a five-minute cache that would compact every short
 * break.
 *
 * Here it fires earlier, at 75% of the lifetime (45 minutes of an hour), and
 * from 100K tokens of context (Claude Code's floor; its default is 200K): a
 * provider keeps a cache on a best-effort basis, so a quarter of the lifetime
 * leaves room for one that goes early, and a 100K re-read already costs more
 * than the summary.
 *
 * The lifetime is the one the request to fork asked for, decided when its
 * reply arrives (requestTtlMs): the model's promptCache for the tier the
 * request used (a long-retention marker in it means the long tier), or else
 * the hour of an Anthropic request that asked for one (cache_control ttl
 * "1h", which Pi sends with PI_CACHE_RETENTION=long), a lifetime the API
 * defines. Anything else is unknown. Without a lifetime of an hour or more,
 * nothing happens. The timer starts when a run settles and counts from the last
 * request; when it fires the conditions are checked again: still idle,
 * nothing queued, no newer request, at least 100K tokens of context
 * (PI_CC_IDLE_COMPACT_MIN_TOKENS raises it),
 * and not more than a minute late. The compaction goes through Pi
 * (ctx.compact), so it is the ordinary pi-cc-compaction compaction.
 */

import type { PiCcConfig } from "./config.ts";
import { runtime } from "./patches.ts";

/** Claude Code idles-compacts only one-hour caches. */
export const IDLE_MIN_TTL_MS = 3600_000;
/**
 * The minimum context for an idle compaction: Claude Code's floor (its
 * default is 200K). Below it a re-read costs little; the override only raises it.
 */
export const IDLE_FLOOR_MIN_TOKENS = 100_000;
export const IDLE_DEFAULT_MIN_TOKENS = IDLE_FLOOR_MIN_TOKENS;
/** When in the lifetime it fires: 45 minutes of an hour (Claude Code: 90%). */
export const IDLE_FRACTION = 0.75;
/** A timer this late finds the cache likely gone (Claude Code's "lapsed"). */
export const IDLE_LATE_MS = 60_000;

export const IDLE_NOTICE = "Compacted while idle, before the prompt cache expired \u00b7 turn off with /pi_cc idle off";

type Env = Record<string, string | undefined>;

type Tier = "long" | "short";
type PromptCacheModel = { promptCache?: { short?: number; long?: number } } | undefined;

/** A model's prompt cache lifetime for a retention tier, in ms; undefined when the model declares none. */
function ttlForTier(model: PromptCacheModel, tier: Tier): number | undefined {
	const seconds = model?.promptCache?.[tier];
	return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
}

/** Anthropic's long cache: cache_control { ttl: "1h" } lives an hour. */
const ANTHROPIC_HOUR_MS = 3600_000;

type Marked = { cache_control?: { ttl?: unknown } } | null | undefined;
const asksForHour = (block: unknown): boolean => (block as Marked)?.cache_control?.ttl === "1h";
const anyAsksForHour = (blocks: unknown): boolean => Array.isArray(blocks) && blocks.some(asksForHour);

/** Whether an Anthropic-format request asked for an hour: Pi marks the system prompt, the last tool and the last message alike. */
function hourMarked(payload: Record<string, unknown>): boolean {
	if (anyAsksForHour(payload.system) || anyAsksForHour(payload.tools)) return true;
	const messages = payload.messages;
	return Array.isArray(messages) && messages.some((message) => anyAsksForHour((message as { content?: unknown } | null)?.content));
}

/**
 * How long the cache a request writes lives, in ms: the model's promptCache
 * for the tier the request asked for (long when it carries a long-retention
 * marker: Anthropic's ttl "1h", OpenAI's prompt_cache_retention or
 * prompt_cache_options ttl), or else an hour when an Anthropic-format request
 * asked for one. Undefined when unknown: what OpenAI-style retention values
 * mean is up to each provider, so they count only when declared.
 */
export function requestTtlMs(payload: unknown, model: unknown): number | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const request = payload as Record<string, unknown>;
	const hour = hourMarked(request);
	const options = request.prompt_cache_options as { ttl?: unknown } | null | undefined;
	const long = hour || request.prompt_cache_retention === "24h" || options?.ttl !== undefined;
	return ttlForTier(model as PromptCacheModel, long ? "long" : "short") ?? (hour ? ANTHROPIC_HOUR_MS : undefined);
}

/** How long after the last request it fires: 75% of the lifetime. */
export function idleDelayMs(ttlMs: number): number {
	return Math.floor(ttlMs * IDLE_FRACTION);
}

export function idleMinTokens(env: Env = process.env): number {
	const raw = Number(env.PI_CC_IDLE_COMPACT_MIN_TOKENS);
	return Number.isFinite(raw) && raw > 0 ? Math.max(IDLE_FLOOR_MIN_TOKENS, raw) : IDLE_DEFAULT_MIN_TOKENS;
}

/** The parts of the extension context idle compaction uses. */
export interface IdleContext {
	hasUI?: boolean;
	ui?: { notify(message: string, level: "info" | "warning" | "error"): void };
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	getContextUsage(): { tokens: number | null } | undefined;
	sessionManager: { getSessionId(): string };
	compact(options?: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }): void;
}

export interface IdleDeps {
	now?: () => number;
	env?: Env;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

/** A failure compact.ts has already shown, as it shows a failed manual /compact ("Compaction failed: …", "Compaction cancelled"). */
function isReportedCompactionError(error: Error): boolean {
	const message = error.message ?? "";
	return /^Compaction (failed|cancelled|aborted)/i.test(message) || /^Compaction$/i.test(message);
}

export class IdleCompactor {
	private timer: unknown;
	/** Its compaction is in flight: from ctx.compact until it completes or fails. */
	compacting = false;
	private readonly now: () => number;
	private readonly env: Env;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (timer: unknown) => void;

	constructor(deps: IdleDeps = {}) {
		this.now = deps.now ?? Date.now;
		this.env = deps.env ?? process.env;
		this.setTimer =
			deps.setTimer ??
			((fn, ms) => {
				const timer = setTimeout(fn, ms);
				timer.unref?.();
				return timer;
			});
		this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	}

	cancel(): void {
		if (this.timer !== undefined) this.clearTimer(this.timer);
		this.timer = undefined;
	}

	/** When the run that just settled warrants it, schedule the idle compaction. */
	arm(ctx: IdleContext, config: Pick<PiCcConfig, "compaction" | "idleCompaction">): void {
		this.cancel();
		if (!config.compaction || !config.idleCompaction) return;
		const plan = this.plan(ctx);
		if (!plan) return;
		this.timer = this.setTimer(() => this.fire(ctx, config, plan), Math.max(0, plan.due - this.now()));
	}

	/** Due at 75% of the lifetime of the last answered request's cache, when that is an hour or more. */
	private plan(ctx: IdleContext): { due: number; requestAt: number } | undefined {
		const capture = runtime().captures.get(ctx.sessionManager.getSessionId());
		if (capture?.ttlMs === undefined || capture.ttlMs < IDLE_MIN_TTL_MS) return undefined;
		if (!this.ready(ctx)) return undefined;
		return { due: capture.at + idleDelayMs(capture.ttlMs), requestAt: capture.at };
	}

	private ready(ctx: IdleContext): boolean {
		try {
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return false;
			const tokens = ctx.getContextUsage()?.tokens;
			return typeof tokens === "number" && tokens >= idleMinTokens(this.env);
		} catch {
			return false;
		}
	}

	private fire(ctx: IdleContext, config: Pick<PiCcConfig, "compaction" | "idleCompaction">, plan: { due: number; requestAt: number }): void {
		this.timer = undefined;
		try {
			if (this.now() - plan.due > IDLE_LATE_MS) return;
			const capture = runtime().captures.get(ctx.sessionManager.getSessionId());
			if (!capture || capture.at !== plan.requestAt) return;
			if (runtime().activeSessions.size > 1 || !config.compaction || !config.idleCompaction || !this.ready(ctx)) return;
			// compact.ts already reports a failed compaction as a manual /compact
			// would (it cannot tell an idle pass from a typed one), so a failure it
			// shows is not repeated here; anything else is.
			this.compacting = true;
			ctx.compact({
				onComplete: () => {
					this.compacting = false;
					this.notify(ctx, IDLE_NOTICE, "info");
				},
				onError: (error) => {
					this.compacting = false;
					if (isReportedCompactionError(error)) return;
					this.notify(ctx, `Idle compaction failed: ${error.message}`, "warning");
				},
			});
		} catch (error) {
			// A synchronous failure never started a compaction. Do not leave this
			// flag hiding the notice from a later manual /compact.
			this.compacting = false;
			this.notify(ctx, `Idle compaction failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	private notify(ctx: IdleContext, message: string, level: "info" | "warning"): void {
		try {
			if (ctx.hasUI) ctx.ui?.notify(message, level);
		} catch {
			// ignore
		}
	}
}
