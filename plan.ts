/**
 * Whether a compaction can read the prompt cache, and so whether pi-cc-compaction
 * takes it.
 *
 * The fork (fork.ts) is the last answered request plus one turn. It reads the
 * cache only if that request's cache is still there, so it is planned when:
 *  - this session has a request that got its reply (patches.ts, commitPending);
 *  - that request went to the current model on the current provider (a cache
 *    belongs to one model, served by one provider);
 *  - the current model speaks one of the forkable APIs;
 *  - its cache has not expired, as far as can be known: the lifetime that
 *    request asked for (idle.ts: the model's promptCache, or Anthropic's
 *    hour), counted from that request. A cache of unknown lifetime cannot be
 *    known to be gone; Claude Code forks without asking, so this does too.
 * Otherwise no cache can be read whatever is sent, and Pi's own compaction
 * runs, with Pi's own settings: the decision is made where Pi reads its
 * compaction settings, before it chooses what to keep (index.ts), and again
 * in session_before_compact (compact.ts).
 */

import { FORKABLE_APIS } from "./fork.ts";
import { runtime, type Capture } from "./patches.ts";

export type ForkPlan = { ok: true; capture: Capture } | { ok: false; reason: string };

export function forkPlan(sessionId: string | undefined, model: { provider?: string; id?: string; api?: string } | undefined, now: number = Date.now()): ForkPlan {
	if (!model) return { ok: false, reason: "there is no model" };
	const capture = sessionId === undefined ? undefined : runtime().captures.get(sessionId);
	if (!capture) return { ok: false, reason: "no request has been answered yet in this session" };
	// The reply's provider/model decides (turn_end records it): the body's model
	// field can differ from Pi's model id (samplingParams { model } renames it).
	const sameModel = capture.modelKey !== undefined ? capture.modelKey === `${model.provider}/${model.id}` : capture.payload.model === model.id;
	if (!sameModel) return { ok: false, reason: "the last request went to another model" };
	if (!model.api || !FORKABLE_APIS.has(model.api)) return { ok: false, reason: `${model.api ?? "this API's"} requests cannot be forked` };
	if (capture.ttlMs !== undefined && now - capture.at >= capture.ttlMs) return { ok: false, reason: "the prompt cache has expired" };
	return { ok: true, capture };
}
