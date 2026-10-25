/**
 * pi-cc-compaction: Claude Code's compaction for Pi.
 *
 * - patches.ts: Pi's compaction settings answer with Claude Code's numbers
 *   (threshold window - min(output cap, 20K) - 13K, no "Nothing to compact"
 *   gate), and each ordinary request is captured as the provider got it.
 * - compact.ts: /compact, the automatic threshold and overflow recovery are
 *   summarized Claude Code's way, by forking the last answered request so the
 *   summary reads the prompt cache. When no cache can be read (plan.ts) Pi's
 *   own compaction runs, with Pi's settings; a fork that fails is cancelled
 *   the way Claude Code cancels it, with its breakers (breaker.ts).
 * - idle.ts: a large conversation is compacted while idle, before a prompt
 *   cache of an hour or more expires. Pi's cache warming is left alone: it
 *   only warms caches of up to about half an hour (its own safety windows),
 *   which idle compaction never touches, so the two never collide.
 *
 * Both features follow the shared pi-cc settings (/pi_cc compact, /pi_cc
 * idle); a change applies at once, without /reload. The extension never
 * changes the system prompt, the tools or the messages of an ordinary
 * request: only the compaction it was asked for.
 */

import { ExtensionRunner, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as breaker from "./breaker.ts";
import { compactionNotice, handleCompaction } from "./compact.ts";
import { invalidateConfig, loadConfig } from "./config.ts";
import { IdleCompactor, requestTtlMs } from "./idle.ts";
import { ccReserveTokens, commitPending, forgetSession, installPatches, runtime } from "./patches.ts";
import { forkPlan } from "./plan.ts";
import { CONFIG_CHANNEL, registerPiCcCommand } from "./settings.ts";

function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning"): void {
	try {
		if (ctx?.hasUI) ctx.ui.notify(message, level);
	} catch {
		// a stale context must never break the extension
	}
}

export default function piCcCompact(pi: ExtensionAPI): void {
	registerPiCcCommand(pi, "pi-cc-compaction");

	const { missing } = installPatches({ SettingsManager, ExtensionRunner });
	const rt = runtime();
	// Pi reads these settings before every threshold check and before it chooses
	// what a compaction keeps. Claude Code's threshold always; keepRecentTokens 1
	// (no "Nothing to compact" gate, pi-cc-compaction chooses what stays) only when
	// the fork can read the cache, otherwise Pi compacts with its own settings;
	// an open breaker turns automatic compaction off.
	rt.override = (model) => {
		if (!loadConfig().compaction) return undefined;
		const sessionId = rt.activeSessionId;
		return {
			reserveTokens: ccReserveTokens(model),
			...(breaker.isOpen(sessionId) ? { enabled: false } : {}),
			...(forkPlan(sessionId, model as { provider?: string; id?: string; api?: string }).ok ? { keepRecentTokens: 1 } : {}),
		};
	};

	const idle = new IdleCompactor();
	let toldMissing = false;

	pi.on("session_start", async (event, ctx) => {
		rt.activeSessionId = ctx.sessionManager.getSessionId();
		// A reload at idle ends no run, so no agent_settled will come to arm
		// the idle compaction: the continuing session's start re-arms it.
		if (event.reason === "reload") idle.arm(ctx, loadConfig());
		if (missing.length > 0 && !toldMissing) {
			toldMissing = true;
			notify(ctx, `pi-cc-compaction: this Pi has no ${missing.join(" or ")}; compaction and its thresholds fall back to Pi's own`, "warning");
		}
	});

	// Pi calls ExtensionRunner.emitBeforeProviderRequest, where requests are
	// captured, only when some extension listens to before_provider_request.
	// This handler is that listener; it returns nothing, so the payload goes on
	// exactly as the other handlers left it.
	pi.on("before_provider_request", () => undefined);

	pi.on("session_before_compact", (event, ctx) => {
		idle.cancel();
		return handleCompaction(event, ctx, loadConfig());
	});

	pi.on("agent_settled", (_event, ctx) => {
		idle.arm(ctx, loadConfig());
	});

	// A reply arrived: the request it answers wrote the cache and becomes the
	// one to fork. An error reply (an overflow, say) wrote nothing: the last
	// success stays. Its cache lives as long as the request asked (idle.ts).
	pi.on("turn_end", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		breaker.noteTurn(sessionId);
		const stop = (event.message as { stopReason?: string } | undefined)?.stopReason;
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		const modelKey = model ? `${model.provider}/${model.id}` : undefined;
		if (stop === "stop" || stop === "toolUse" || stop === "length") {
			const pending = rt.pending.get(sessionId);
			commitPending(sessionId, { modelKey, ttlMs: pending && requestTtlMs(pending.payload, ctx.model) });
		}
		return undefined;
	});

	pi.on("agent_start", () => {
		idle.cancel();
	});
	pi.on("model_select", () => {
		idle.cancel();
	});
	// Compacted: the conversation now starts with the summary, a new prefix the
	// next request caches. Any success also forgives earlier failures.
	pi.on("session_compact", (event, ctx) => {
		idle.cancel();
		const sessionId = ctx.sessionManager.getSessionId();
		forgetSession(sessionId);
		breaker.noteSuccess(sessionId);
		// Whose compaction it was. Pi clears and redraws the transcript right
		// after this event (compaction_end, in the same tick): the notice waits
		// for the next one, or the redraw would wipe it.
		const notice = compactionNotice(sessionId, event, { idle: idle.compacting });
		if (notice) setTimeout(() => notify(ctx, notice, "info"), 0);
	});

	// Another branch: the held request's prefix no longer leads here.
	pi.on("session_tree", (_event, ctx) => {
		idle.cancel();
		forgetSession(ctx.sessionManager.getSessionId());
	});

	// A reload ends the extension instances, not the session: the last
	// answered request is still the one to fork, and a request still in flight
	// still gets its reply. The extension was never in this session's turns
	// (loaded mid-session): there is no capture to keep, and that compaction
	// falls back to Pi's, which the notice after it says.
	pi.on("session_shutdown", (event, ctx) => {
		idle.cancel();
		try {
			if (event.reason === "reload") return;
			const sessionId = ctx.sessionManager.getSessionId();
			forgetSession(sessionId);
			breaker.reset(sessionId);
			if (rt.activeSessionId === sessionId) rt.activeSessionId = undefined;
		} catch {
			// nothing to forget
		}
	});

	pi.events.on(CONFIG_CHANNEL, () => {
		invalidateConfig();
		if (!loadConfig().idleCompaction) idle.cancel();
	});
}
