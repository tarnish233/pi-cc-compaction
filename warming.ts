/**
 * Pi's cache warming, switched off while idle compaction is on.
 *
 * Both keep a long conversation from paying for an expired cache: Pi's
 * warmer by refreshing the cache with small requests, idle compaction by
 * compacting before it expires. With idle compaction on the warmer is not
 * needed, and both acting on the same cache would collide, so idle
 * compaction turns cacheWarming off in settings.json and remembers what it
 * was (in pi-cc.json, as idleCompactionSavedCacheWarming; null when the key
 * was absent). Turning idle compaction off puts that value back, unless the
 * user changed cacheWarming in the meantime: then their value stands and
 * only the memo goes. Nothing else is touched: the warmer, compaction
 * thresholds and the rest of settings.json stay as they were.
 *
 * The change goes through Pi's own SettingsManager, which locks
 * settings.json and merges just this key. Pi's live settings object is
 * used when pi-cc-compact has seen it (patches.ts), so the running Pi
 * changes too; before that, a SettingsManager made for the purpose writes
 * the file, and the cache_warming_decision handler in index.ts stops the
 * warmer of the running Pi meanwhile.
 *
 * Uninstalling pi-cc-compact cannot restore the value: turn idle compaction
 * off first (/pi_cc idle off).
 */

import fs from "node:fs";
import path from "node:path";
import type { PiCcConfig } from "./config.ts";
import type { SettingsLike } from "./patches.ts";

/** The pi-cc.json key holding cacheWarming as it was before idle compaction. */
export const SAVED_KEY = "idleCompactionSavedCacheWarming";

/** Idle compaction is in effect only with Claude Code's compaction on as well. */
export function warmingBlocked(config: Pick<PiCcConfig, "compaction" | "idleCompaction">): boolean {
	return config.compaction && config.idleCompaction;
}

export interface WarmingDeps {
	/** Pi's agent directory, where settings.json is. */
	agentDir: string;
	/** pi-cc.json. */
	configFile: string;
	/** Pi's live settings object, when pi-cc-compact has seen it. */
	live?: SettingsLike;
	/** A SettingsManager for the agent directory, used without the live one. */
	create(): SettingsLike;
}

function readJson(file: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function writeJson(file: string, data: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	fs.renameSync(temp, file);
}

async function setMode(deps: WarmingDeps, mode: string | undefined): Promise<void> {
	const target = typeof deps.live?.setCacheWarmingMode === "function" ? deps.live : deps.create();
	target.setCacheWarmingMode?.(mode);
	await target.flush?.();
}

/**
 * Bring cacheWarming in line with the settings: off while idle compaction is
 * in effect, back to what it was when it is not.
 */
export async function syncCacheWarming(config: Pick<PiCcConfig, "compaction" | "idleCompaction">, deps: WarmingDeps): Promise<"disabled" | "restored" | "unchanged"> {
	const settings = readJson(path.join(deps.agentDir, "settings.json"));
	const current = typeof settings.cacheWarming === "string" ? settings.cacheWarming : undefined;
	const piCc = readJson(deps.configFile);
	const remembered = Object.hasOwn(piCc, SAVED_KEY);

	if (warmingBlocked(config)) {
		if (current === "off") {
			// The file is right; make the running Pi agree if it does not yet.
			if (deps.live?.getCacheWarmingMode && deps.live.getCacheWarmingMode() !== "off") {
				deps.live.setCacheWarmingMode?.("off");
				await deps.live.flush?.();
			}
			return "unchanged";
		}
		if (!remembered) writeJson(deps.configFile, { ...piCc, [SAVED_KEY]: current ?? null });
		await setMode(deps, "off");
		return "disabled";
	}

	if (!remembered) return "unchanged";
	const saved = piCc[SAVED_KEY];
	const { [SAVED_KEY]: _memo, ...rest } = piCc;
	const restore = current === "off";
	if (restore) await setMode(deps, typeof saved === "string" ? saved : undefined);
	writeJson(deps.configFile, rest);
	return restore ? "restored" : "unchanged";
}
