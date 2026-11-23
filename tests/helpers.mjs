import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findPiInstall as findHost } from "../scripts/host-paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const extensionDir = path.resolve(here, "..");

/** Resolve Pi without treating a test's isolated agent dir (PI_CODING_AGENT_DIR) as an install. */
function resolveHost() {
	const isolated = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		return findHost();
	} finally {
		if (isolated !== undefined) process.env.PI_CODING_AGENT_DIR = isolated;
	}
}

/** The resolved installation plus the aliases this facade's tests use. */
export function findPiInstall() {
	const install = resolveHost();
	return {
		...install,
		version: install.versions.at(-1),
		piAi: path.join(install.root, "@earendil-works", "pi-ai", "dist", "compat.js"),
		keybindings: path.join(path.dirname(install.piCodingAgent), "core", "keybindings.js"),
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
			"@earendil-works/pi-ai": install.piAi,
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
