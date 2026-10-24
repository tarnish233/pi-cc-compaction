import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const extensionDir = path.resolve(here, "..");

/**
 * Locate the Pi installation that ships the extension host and jiti. Set
 * PI_AGENT_DIR to test against another one (e.g. a directory whose
 * install/releases holds only 1.3.0).
 */
export function findPiInstall() {
	const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const releases = path.join(agentDir, "install", "releases");
	const candidates = fs.existsSync(releases) ? fs.readdirSync(releases) : [];
	const versions = candidates
		.filter((name) => fs.existsSync(path.join(releases, name, "node_modules", "jiti")))
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	if (!versions.length) {
		throw new Error(
			`Could not find a Pi installation with jiti under ${releases}. ` +
				"Set PI_AGENT_DIR to point at your agent directory.",
		);
	}
	const version = versions[versions.length - 1];
	const root = path.join(releases, version, "node_modules");
	const agent = path.join(root, "@earendil-works", "pi-coding-agent", "dist");
	return {
		version,
		root,
		jiti: path.join(root, "jiti", "lib", "jiti.mjs"),
		// Pi aliases these for extensions at load time; the harness does the same,
		// so the extension and the tests share Pi's modules.
		piCodingAgent: path.join(agent, "index.js"),
		piTui: path.join(root, "@earendil-works", "pi-tui", "dist", "index.js"),
		keybindings: path.join(agent, "core", "keybindings.js"),
	};
}

let jitiInstance;
async function makeJiti() {
	if (jitiInstance) return jitiInstance;
	const install = findPiInstall();
	const { createJiti } = await import(pathToFileURL(install.jiti).href);
	jitiInstance = createJiti(pathToFileURL(path.join(extensionDir, "package.json")).href, {
		alias: {
			"@earendil-works/pi-coding-agent": install.piCodingAgent,
			"@earendil-works/pi-tui": install.piTui,
		},
	});
	return jitiInstance;
}

/** Import one of the package's TypeScript modules. */
export async function loadModule(name) {
	const jiti = await makeJiti();
	return jiti.import(path.join(extensionDir, name));
}

/** Pi's own modules, as the extensions see them. */
export async function loadPi() {
	const install = findPiInstall();
	const jiti = await makeJiti();
	const agent = await jiti.import(install.piCodingAgent);
	const tui = await jiti.import(install.piTui);
	const { KeybindingsManager } = await jiti.import(install.keybindings);
	return { agent, tui, KeybindingsManager, version: install.version };
}

/**
 * A stand-in for the ExtensionAPI: records handlers, entries, renderers and
 * commands. Any other API call is recorded in `calls`, so tests can see that
 * an extension never reaches for what the model sees.
 */
export function fakePi() {
	const handlers = new Map();
	const entries = [];
	const renderers = new Map();
	const commands = new Map();
	const busEvents = [];
	const busListeners = new Map();
	const calls = [];
	const known = {
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => handlers.set(event, handlers.get(event).filter((h) => h !== handler));
		},
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
		registerEntryRenderer(customType, renderer) {
			renderers.set(customType, renderer);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		events: {
			emit(channel, data) {
				busEvents.push({ channel, data });
				// The real bus dispatches to the listeners.
				const list = busListeners.get(channel);
				if (list) for (const fn of [...list]) fn(data);
			},
			on(channel, handler) {
				if (!busListeners.has(channel)) busListeners.set(channel, []);
				busListeners.get(channel).push(handler);
			},
		},
	};
	const pi = new Proxy(known, {
		get(target, prop) {
			if (prop in target) return target[prop];
			return (...args) => {
				calls.push({ method: String(prop), args });
			};
		},
	});
	/** Run the handlers for an event; returns what they returned. */
	async function emit(event, payload = {}, ctx = {}) {
		const results = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
		return results;
	}
	return { pi, handlers, entries, renderers, commands, busEvents, calls, emit };
}

/** The context Pi hands handlers in the interactive TUI. */
export const TUI_CTX = { mode: "tui", hasUI: true };

/** The sibling extension directory (the pi-cc packages live side by side). */
export function siblingExtensionDir(name) {
	return path.resolve(extensionDir, "..", name);
}

export const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
