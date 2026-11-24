/**
 * Independent settings for pi-cc-compaction.
 *
 * Saved in Pi's agent directory as pi-cc-compaction.json. When that file is
 * missing, this package inherits only its own valid keys from pi-cc.json;
 * its first save copies those choices without changing the old file.
 * PI_CC_CONFIG_FILE explicitly selects a file and disables legacy fallback.
 * Environment overrides win while set and are never written to the file:
 *   PI_CC_COMPACTION=0|1
 *   PI_CC_IDLE_COMPACTION=0|1
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PiCcConfig {
	/** Claude Code's compaction replaces Pi's summary request. */
	compaction: boolean;
	/** Compact while idle, before a long prompt cache expires. */
	idleCompaction: boolean;
}

export const DEFAULT_CONFIG: PiCcConfig = {
	compaction: true,
	idleCompaction: true,
};

const ENV_OVERRIDES: Record<keyof PiCcConfig, string> = {
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

export function configPath(): string {
	return process.env.PI_CC_CONFIG_FILE || path.join(getAgentDir(), "pi-cc-compaction.json");
}

function readSettingsFile(file: string): Record<string, unknown> {
	const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** Inherit only this package's settings, never defaults or environment overrides. */
function legacyConfig(): Partial<PiCcConfig> {
	if (process.env.PI_CC_CONFIG_FILE) return {};
	let raw: Record<string, unknown>;
	try {
		raw = readSettingsFile(path.join(getAgentDir(), "pi-cc.json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
		return {};
	}
	const inherited: Partial<PiCcConfig> = {};
	for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof PiCcConfig>) {
		if (typeof raw[key] === "boolean") inherited[key] = raw[key] as boolean;
	}
	return inherited;
}

/** The environment variable overriding a setting right now, or undefined. */
export function envOverride(key: keyof PiCcConfig): string | undefined {
	const name = ENV_OVERRIDES[key];
	return envBool(name) === undefined ? undefined : `${name}=${process.env[name]}`;
}

function readConfig(): PiCcConfig {
	let file: Record<string, unknown> = {};
	try {
		file = readSettingsFile(configPath());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			try { file = legacyConfig(); } catch {
				// An unreadable legacy file uses defaults; saving must still reject it.
			}
		}
	}
	const config = { ...DEFAULT_CONFIG };
	for (const key of Object.keys(config) as Array<keyof PiCcConfig>) {
		config[key] = envBool(ENV_OVERRIDES[key]) ?? (typeof file[key] === "boolean" ? file[key] as boolean : DEFAULT_CONFIG[key]);
	}
	return config;
}

let cached: PiCcConfig | undefined;

/** Load the settings. Cached until `invalidateConfig` or `saveConfig`. */
export function loadConfig(): PiCcConfig {
	if (!cached) cached = readConfig();
	return cached;
}

/** Forget the cached settings, e.g. after a manual edit. */
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
 * effect. Existing keys are preserved; the first save also inherits this
 * package's legacy choices. Environment overrides are never copied. They still
 * win over the file while set, so the returned value can differ from
 * the patch (see `envOverride`).
 */
export function saveConfig(patch: Partial<PiCcConfig>): PiCcConfig {
	const file = configPath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	withFileLock(file, () => {
		// Keep unknown keys in the new file; the legacy file remains untouched.
		let raw: Record<string, unknown> = {};
		try {
			raw = readSettingsFile(file);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// EACCES/EIO must never turn an unreadable file into a lossy rewrite.
			if (code === "ENOENT") raw = legacyConfig();
			else if (!(error instanceof SyntaxError)) throw error;
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
