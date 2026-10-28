/**
 * Shared settings for the pi-cc extensions.
 *
 * pi-cc-loop, pi-cc-monitor, pi-cc-plugins and pi-cc-compaction read the same
 * small JSON file so a single toggle changes the whole family at once. The file is optional;
 * when it is missing or malformed the defaults apply. It sits in Pi's agent
 * directory (PI_CODING_AGENT_DIR, default ~/.pi/agent), next to Pi's own
 * settings.
 *
 *   ~/.pi/agent/pi-cc.json
 *   {
 *     "compactMessages": true,
 *     "footer": true,
 *     "draft": true,
 *     "turnSummary": true,
 *     "ccKeys": true,
 *     "compaction": true,
 *     "idleCompaction": true
 *   }
 *
 * compactMessages and footer drive loop and monitor; draft, turnSummary and
 * ccKeys drive pi-cc-plugins; compaction and idleCompaction drive pi-cc-compaction. A package that is not installed simply ignores its
 * keys, and they are kept as the user left them.
 *
 * Environment overrides (useful for tests and quick experiments) win over the
 * file while they are set, and are never written to it:
 *   PI_CC_CONFIG_FILE=/path/to/pi-cc.json
 *   PI_CC_COMPACT_MESSAGES=0|1
 *   PI_CC_FOOTER=0|1
 *   PI_CC_DRAFT=0|1
 *   PI_CC_TURN_SUMMARY=0|1
 *   PI_CC_KEYS=0|1
 *   PI_CC_COMPACTION=0|1
 *   PI_CC_IDLE_COMPACTION=0|1
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PiCcConfig {
	/** Two-line marker blocks instead of the padded card. */
	compactMessages: boolean;
	/**
	 * Show a one-line summary in Pi's footer (loops armed, monitors running).
	 * Shared so one switch silences both packages.
	 */
	footer: boolean;
	/** pi-cc-plugins: Ctrl+C keeps what it clears, Up brings it back. */
	draft: boolean;
	/** pi-cc-plugins: one line closes every agent run. */
	turnSummary: boolean;
	/** pi-cc-plugins: Enter queues while Pi works; no Ctrl+Enter shortcut. */
	ccKeys: boolean;
	/** pi-cc-compaction: Claude Code's compaction replaces Pi's summary request. */
	compaction: boolean;
	/** pi-cc-compaction: compact while idle, before a long prompt cache expires. */
	idleCompaction: boolean;
}

export const DEFAULT_CONFIG: PiCcConfig = {
	compactMessages: true,
	footer: true,
	draft: true,
	turnSummary: true,
	ccKeys: true,
	compaction: true,
	idleCompaction: true,
};

/** The environment variable that overrides each setting. */
const ENV_OVERRIDES: Record<keyof PiCcConfig, string> = {
	compactMessages: "PI_CC_COMPACT_MESSAGES",
	footer: "PI_CC_FOOTER",
	draft: "PI_CC_DRAFT",
	turnSummary: "PI_CC_TURN_SUMMARY",
	ccKeys: "PI_CC_KEYS",
	compaction: "PI_CC_COMPACTION",
	idleCompaction: "PI_CC_IDLE_COMPACTION",
};

function envBool(name: string): boolean | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	if (/^(0|false|off|no)$/i.test(raw)) return false;
	if (/^(1|true|on|yes)$/i.test(raw)) return true;
	return undefined;
}

/** The variable overriding a setting right now, as `PI_CC_FOOTER=0`; undefined when none is. */
export function envOverride(key: keyof PiCcConfig): string | undefined {
	const name = ENV_OVERRIDES[key];
	return envBool(name) === undefined ? undefined : `${name}=${process.env[name]}`;
}

/** The settings file shared by the pi-cc packages, in Pi's agent directory. */
export function configPath(): string {
	if (process.env.PI_CC_CONFIG_FILE) return process.env.PI_CC_CONFIG_FILE;
	return path.join(getAgentDir(), "pi-cc.json");
}

/** One setting: an environment override, else the file's boolean, else the default. */
function readSetting(file: Partial<PiCcConfig>, key: keyof PiCcConfig): boolean {
	return envBool(ENV_OVERRIDES[key]) ?? (typeof file[key] === "boolean" ? (file[key] as boolean) : DEFAULT_CONFIG[key]);
}

function readConfig(): PiCcConfig {
	let file: Partial<PiCcConfig> = {};
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8")) as unknown;
		if (parsed && typeof parsed === "object") file = parsed as Partial<PiCcConfig>;
	} catch {
		// Missing or malformed files fall back to defaults.
	}
	// One loop over the defaults, so a setting added to DEFAULT_CONFIG is read
	// without a second edit here.
	const config = { ...DEFAULT_CONFIG };
	for (const key of Object.keys(config) as Array<keyof PiCcConfig>) config[key] = readSetting(file, key);
	return config;
}

let cached: PiCcConfig | undefined;

/** Load the settings. Cached until `invalidateConfig` or `saveConfig`. */
export function loadConfig(): PiCcConfig {
	if (!cached) cached = readConfig();
	return cached;
}

/** Forget the cached settings, e.g. after another extension changed the file. */
export function invalidateConfig(): void {
	cached = undefined;
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 60_000;
const sleep = new Int32Array(new SharedArrayBuffer(4));

function removeStaleLock(lock: string): void {
	try {
		const stat = fs.statSync(lock);
		const age = Date.now() - stat.mtimeMs;
		if (age < 100) return; // A new writer may not have filled it yet.
		let stale = age > LOCK_STALE_MS;
		if (!stale) {
			const holder = JSON.parse(fs.readFileSync(lock, "utf8")) as { pid?: number; hostname?: string };
			if (holder.hostname === os.hostname() && typeof holder.pid === "number") {
				try { process.kill(holder.pid, 0); } catch (error) {
					stale = (error as NodeJS.ErrnoException).code === "ESRCH";
				}
			}
		}
		// Do not unlink a lock that another process replaced while we inspected it.
		const current = fs.statSync(lock);
		if (stale && current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) fs.rmSync(lock);
	} catch {
		// A writer may still be filling it, or another process removed it.
	}
}

/** Serialize a short read-modify-write across Pi processes, not just modules in one process. */
export function withFileLock<T>(file: string, change: () => T): T {
	const lock = `${file}.write.lock`;
	const token = randomUUID();
	const started = Date.now();
	for (;;) {
		let fd: number;
		try {
			fd = fs.openSync(lock, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			removeStaleLock(lock);
			if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`Timed out waiting for ${lock}`);
			Atomics.wait(sleep, 0, 0, 20);
			continue;
		}
		try {
			fs.writeSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), token }));
		} catch (error) {
			fs.rmSync(lock, { force: true });
			throw error;
		} finally {
			fs.closeSync(fd);
		}
		break;
	}
	try {
		return change();
	} finally {
		try {
			const holder = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: string };
			if (holder.token === token) fs.rmSync(lock);
		} catch {
			// A stale lock may have been replaced; never remove a new owner's lock.
		}
	}
}

/**
 * Write the changed keys to the settings file and return the settings now in
 * effect. Only the patch is written: every other key stays as the user left
 * it, and an environment override is never copied into the file. It still
 * wins over the file while it is set, so the returned value can differ from
 * the patch (see `envOverride`).
 */
export function saveConfig(patch: Partial<PiCcConfig>): PiCcConfig {
	const file = configPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	withFileLock(file, () => {
		// Keep keys this version does not know about: the file is the user's.
		let raw: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
		} catch {
			// A missing or malformed file is rewritten from scratch.
		}
		const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			fs.writeFileSync(temp, `${JSON.stringify({ ...raw, ...patch }, null, 2)}\n`, "utf8");
			fs.renameSync(temp, file);
		} finally {
			fs.rmSync(temp, { force: true });
		}
	});
	cached = undefined;
	return loadConfig();
}
