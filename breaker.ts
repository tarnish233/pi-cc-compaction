/**
 * Claude Code's two breakers for automatic compaction (2.1.308).
 *
 * - Failures: three automatic compactions failing in a row stop automatic
 *   compaction for the session ("circuit breaker tripped after 3 consecutive
 *   failures - skipping future attempts this session"). A success resets the
 *   count.
 * - Thrashing: when the context refills to the threshold within three turns
 *   of the previous compaction, three times in a row, compacting again cannot
 *   help ("Autocompact is thrashing"): a file read or a tool output is too
 *   large for the window. Automatic compaction stops.
 *
 * Open, the breaker turns Pi's automatic compaction off for the session
 * (index.ts answers enabled: false); /compact still works, and a successful
 * compaction closes it. State lives on the shared runtime, so /reload keeps it.
 */

export const FAILURE_LIMIT = 3;
/** A refill within this many turns of the last compaction is rapid (Claude Code's D5t). */
export const RAPID_TURNS = 3;
export const RAPID_LIMIT = 3;

export interface BreakerState {
	failures: number;
	rapidRefills: number;
	/** Turns since the last compaction; undefined before the first. */
	turnsSinceCompact: number | undefined;
	open: "failures" | "thrashing" | undefined;
}

const BREAKERS = Symbol.for("pi-cc-compaction:breakers");

function all(): Map<string, BreakerState> {
	const holder = globalThis as typeof globalThis & Record<symbol, Map<string, BreakerState> | undefined>;
	holder[BREAKERS] ??= new Map();
	return holder[BREAKERS];
}

export function state(sessionId: string): BreakerState {
	let current = all().get(sessionId);
	if (!current) {
		current = { failures: 0, rapidRefills: 0, turnsSinceCompact: undefined, open: undefined };
		all().set(sessionId, current);
	}
	return current;
}

export function reset(sessionId: string): void {
	all().delete(sessionId);
}

export function isOpen(sessionId: string | undefined): boolean {
	return sessionId !== undefined && state(sessionId).open !== undefined;
}

export function openReason(sessionId: string): BreakerState["open"] {
	return state(sessionId).open;
}

/** A turn ended. */
export function noteTurn(sessionId: string): void {
	const current = state(sessionId);
	if (current.turnsSinceCompact !== undefined) current.turnsSinceCompact++;
}

/** A compaction succeeded: failures are forgiven and the refill clock restarts. */
export function noteSuccess(sessionId: string): void {
	const current = state(sessionId);
	current.failures = 0;
	current.open = undefined;
	current.turnsSinceCompact = 0;
}

/** An automatic compaction failed. True when this failure opens the breaker. */
export function noteFailure(sessionId: string): boolean {
	const current = state(sessionId);
	current.failures++;
	if (current.failures < FAILURE_LIMIT || current.open) return false;
	current.open = "failures";
	return true;
}

/** An automatic compaction is about to run. True when it is the refill that opens the thrash breaker. */
export function noteAutoCompaction(sessionId: string): boolean {
	const current = state(sessionId);
	const rapid = current.turnsSinceCompact !== undefined && current.turnsSinceCompact < RAPID_TURNS;
	current.rapidRefills = rapid ? current.rapidRefills + 1 : 0;
	if (current.rapidRefills < RAPID_LIMIT) return false;
	current.open = "thrashing";
	return true;
}
