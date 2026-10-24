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
 * The lifetime is the model's promptCache entry for the retention Pi uses,
 * the same number Pi's cache warmer reads. The retention is decided as Pi
 * decides it for each request: PI_CACHE_RETENTION from the provider's own
 * environment (the env of its auth.json entry) first, then from the
 * process; "long" picks the long tier, anything else the short one. Without one of an hour or more, nothing
 * happens. The timer starts when a run settles and counts from the last
 * request; when it fires the conditions are checked again: still idle,
 * nothing queued, no newer request, at least 200K tokens of context (Claude
 * Code's default; PI_CC_IDLE_COMPACT_MIN_TOKENS changes it, not below 100K),
 * and not more than a minute late. The compaction goes through Pi
 * (ctx.compact), so it is the ordinary pi-cc-compact compaction.
 */

import type { PiCcConfig } from "./config.ts";
import { runtime } from "./patches.ts";

/** Claude Code idles-compacts only one-hour caches. */
export const IDLE_MIN_TTL_MS = 3600_000;
/** Claude Code's minimum context for an idle compaction, and the floor of its override. */
export const IDLE_DEFAULT_MIN_TOKENS = 200_000;
export const IDLE_FLOOR_MIN_TOKENS = 100_000;
/** A timer this late finds the cache likely gone (Claude Code's "lapsed"). */
export const IDLE_LATE_MS = 60_000;

export const IDLE_NOTICE = "Compacted while idle, before the prompt cache expired \u00b7 turn off with /pi_cc idle off";

type Env = Record<string, string | undefined>;

type Tier = "long" | "short";
type PromptCacheModel = { promptCache?: { short?: number; long?: number } } | undefined;

/** A model's prompt cache lifetime for a retention tier, in ms; undefined when the model declares none. */
export function ttlForTier(model: PromptCacheModel, tier: Tier): number | undefined {
	const seconds = model?.promptCache?.[tier];
	return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
}

/** The prompt cache lifetime for the retention an environment selects, in ms. */
export function promptCacheTtlMs(model: PromptCacheModel, env: Env = process.env): number | undefined {
	return ttlForTier(model, env.PI_CACHE_RETENTION === "long" ? "long" : "short");
}

/** What idle compaction asks of the model registry: the provider's own environment. */
interface RegistryLike {
	getApiKeyAndHeaders?(model: never): Promise<{ ok: boolean; env?: Record<string, string> }>;
}

/**
 * The retention tier of this model's requests, decided as Pi decides it
 * (getProviderEnvValue): the provider's PI_CACHE_RETENTION, then the
 * process's. Without the provider's environment (no auth, a failed lookup),
 * the process decides.
 */
export async function cacheRetentionTier(ctx: { model?: unknown; modelRegistry?: RegistryLike }, env: Env = process.env): Promise<Tier> {
	let providerEnv: Record<string, string> | undefined;
	try {
		const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(ctx.model as never);
		if (auth?.ok) providerEnv = auth.env;
	} catch {
		// the process environment decides
	}
	return (providerEnv?.PI_CACHE_RETENTION || env.PI_CACHE_RETENTION) === "long" ? "long" : "short";
}

/** 90% of the lifetime, with ten seconds of margin at least: when Claude Code and Pi's warmer act. */
export function idleDelayMs(ttlMs: number): number {
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

export function idleMinTokens(env: Env = process.env): number {
	const raw = Number(env.PI_CC_IDLE_COMPACT_MIN_TOKENS);
	return Number.isFinite(raw) && raw > 0 ? Math.max(IDLE_FLOOR_MIN_TOKENS, raw) : IDLE_DEFAULT_MIN_TOKENS;
}

/** The parts of the extension context idle compaction uses. */
export interface IdleContext {
	model?: unknown;
	hasUI?: boolean;
	ui?: { notify(message: string, level: "info" | "warning" | "error"): void };
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	getContextUsage(): { tokens: number | null } | undefined;
	sessionManager: { getSessionId(): string };
	compact(options?: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void }): void;
	modelRegistry?: RegistryLike;
}

export interface IdleDeps {
	now?: () => number;
	env?: Env;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

export class IdleCompactor {
	private timer: unknown;
	/** Bumped by every cancel and arm, so an arm still looking up its provider knows it was superseded. */
	private generation = 0;
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
		this.generation++;
		if (this.timer !== undefined) this.clearTimer(this.timer);
		this.timer = undefined;
	}

	/** When the run that just settled warrants it, schedule the idle compaction. */
	async arm(ctx: IdleContext, config: Pick<PiCcConfig, "compaction" | "idleCompaction">): Promise<void> {
		this.cancel();
		const generation = this.generation;
		if (!config.compaction || !config.idleCompaction) return;
		const tier = await cacheRetentionTier(ctx, this.env);
		if (generation !== this.generation) return; // cancelled or re-armed meanwhile
		const plan = this.plan(ctx, tier);
		if (!plan) return;
		this.timer = this.setTimer(() => this.fire(ctx, config, plan), Math.max(0, plan.due - this.now()));
	}

	private plan(ctx: IdleContext, tier: Tier): { due: number; requestAt: number } | undefined {
		const ttl = ttlForTier(ctx.model as never, tier);
		if (ttl === undefined || ttl < IDLE_MIN_TTL_MS) return undefined;
		if (!this.ready(ctx)) return undefined;
		const capture = runtime().captures.get(ctx.sessionManager.getSessionId());
		if (!capture) return undefined;
		return { due: capture.at + idleDelayMs(ttl), requestAt: capture.at };
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
			if (!config.compaction || !config.idleCompaction || !this.ready(ctx)) return;
			ctx.compact({
				onComplete: () => this.notify(ctx, IDLE_NOTICE, "info"),
				onError: (error) => this.notify(ctx, `Idle compaction failed: ${error.message}`, "warning"),
			});
		} catch {
			// a stale context (the session ended) must not throw from a timer
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
