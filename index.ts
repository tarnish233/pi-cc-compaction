/**
 * pi-cc-compact: Claude Code's compaction for Pi.
 *
 * - patches.ts: Pi's compaction settings answer with Claude Code's numbers
 *   (threshold window - min(output cap, 20K) - 13K, no "Nothing to compact"
 *   gate), and each ordinary request is captured as the provider got it.
 * - compact.ts: /compact, the automatic threshold and overflow recovery are
 *   summarized Claude Code's way, by forking the captured request so the
 *   summary reads the prompt cache; Pi's own compaction is the last resort.
 * - idle.ts: a large conversation is compacted while idle, before a prompt
 *   cache of an hour or more expires.
 * - warming.ts: Pi's cache warming is off while idle compaction is on, and
 *   comes back when it is turned off.
 *
 * Both features follow the shared pi-cc settings (/pi_cc compact, /pi_cc
 * idle); a change applies at once, without /reload. The extension never
 * changes the system prompt, the tools or the messages of an ordinary
 * request: only the compaction it was asked for.
 */

import { ExtensionRunner, SettingsManager, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleCompaction } from "./compact.ts";
import { configPath, invalidateConfig, loadConfig } from "./config.ts";
import { IdleCompactor } from "./idle.ts";
import { ccReserveTokens, installPatches, runtime } from "./patches.ts";
import { CONFIG_CHANNEL, registerPiCcCommand } from "./settings.ts";
import { syncCacheWarming, warmingBlocked } from "./warming.ts";

function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning"): void {
	try {
		if (ctx?.hasUI) ctx.ui.notify(message, level);
	} catch {
		// a stale context must never break the extension
	}
}

export default function piCcCompact(pi: ExtensionAPI): void {
	registerPiCcCommand(pi, "pi-cc-compact");

	const { missing } = installPatches({ SettingsManager, ExtensionRunner });
	const rt = runtime();
	rt.override = (model) => (loadConfig().compaction ? { keepRecentTokens: 1, reserveTokens: ccReserveTokens(model) } : undefined);

	const idle = new IdleCompactor();
	let lastCtx: ExtensionContext | undefined;
	let toldMissing = false;

	const syncWarming = async (ctx: ExtensionContext): Promise<void> => {
		try {
			const result = await syncCacheWarming(loadConfig(), {
				agentDir: getAgentDir(),
				configFile: configPath(),
				live: rt.settings,
				create: () => SettingsManager.create(ctx.cwd, getAgentDir()),
			});
			if (result === "disabled") {
				notify(ctx, "Idle compaction turned Pi's cache warming off (cacheWarming: off) \u00b7 /pi_cc idle off turns it back on", "info");
			} else if (result === "restored") {
				notify(ctx, "Pi's cache warming is back as it was", "info");
			}
		} catch (error) {
			notify(ctx, `pi-cc-compact: could not change cacheWarming: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		if (missing.length > 0 && !toldMissing) {
			toldMissing = true;
			notify(ctx, `pi-cc-compact: this Pi has no ${missing.join(" or ")}; compaction falls back to the summary request and Pi's thresholds`, "warning");
		}
		await syncWarming(ctx);
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

	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		const config = loadConfig();
		await idle.arm(ctx, config);
		// Pi's live settings object shows up with the first threshold check: make its memory agree.
		if (warmingBlocked(config) && rt.settings?.getCacheWarmingMode && rt.settings.getCacheWarmingMode() !== "off") await syncWarming(ctx);
	});

	pi.on("agent_start", () => {
		idle.cancel();
	});
	pi.on("model_select", () => {
		idle.cancel();
	});
	pi.on("session_compact", () => {
		idle.cancel();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		idle.cancel();
		try {
			rt.captures.delete(ctx.sessionManager.getSessionId());
		} catch {
			// nothing to forget
		}
	});

	// The running Pi may still hold its old cacheWarming in memory: stop each refresh while idle compaction is on.
	pi.on("cache_warming_decision", () => (warmingBlocked(loadConfig()) ? { action: "stop" as const } : undefined));

	pi.events.on(CONFIG_CHANNEL, () => {
		invalidateConfig();
		const config = loadConfig();
		if (!config.compaction || !config.idleCompaction) idle.cancel();
		if (lastCtx) void syncWarming(lastCtx);
	});
}
