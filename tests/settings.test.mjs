const COMMAND = "compaction_settings";
const TITLE = "Compaction";
const CHANNEL = "pi-cc-compaction:config";
const FIELDS = ["compaction","idleCompaction"];
const WORDS = ["compact","idle"];
const LABELS = ["CC compaction","Idle compaction"];
const OVERRIDE = "PI_CC_COMPACTION";
const FOREIGN = "footer";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall, loadModule } from "./helpers.mjs";

const config = await loadModule("config.ts");
const { registerSettingsCommand, CONFIG_CHANNEL } = await loadModule("settings.ts");
const { visibleWidth, TuiAltScreen, KeybindingsManager, TUI_KEYBINDINGS } = await import(pathToFileURL(findPiInstall().piTui).href);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

async function withFile(body, initial = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-command-"));
	const file = path.join(dir, "settings.json");
	const env = { PI_CC_CONFIG_FILE: file, [OVERRIDE]: undefined };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.writeFileSync(file, JSON.stringify(initial));
		config.invalidateConfig();
		return await body(file, dir);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		config.invalidateConfig();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function host() {
	const commands = new Map(), events = [], notifications = [];
	const pi = {
		registerCommand(name, command) { commands.set(name, command); },
		events: { emit(channel, data) { events.push({ channel, data }); } },
	};
	const ctx = { mode: "tui", hasUI: true, ui: { notify(message, level) { notifications.push({ message, level }); } } };
	registerSettingsCommand(pi);
	return { pi, ctx, commands, events, notifications, command: commands.get(COMMAND) };
}

function open(h) {
	let panel, options, renders = 0;
	h.ctx.ui.custom = (factory, suppliedOptions) => new Promise((resolve) => {
		options = suppliedOptions;
		panel = factory({ requestRender() { renders++; } }, { fg: (_role, text) => text, bold: (text) => text }, {}, resolve);
	});
	const closed = h.command.handler("", h.ctx);
	assert.ok(panel, "the settings panel opened");
	return { panel, closed, options, screen: (width = 100) => panel.render(width).join("\n"), renders: () => renders };
}

test("the package registers its own command without command ownership or discovery", () => {
	const h = host();
	assert.deepEqual([...h.commands.keys()], [COMMAND]);
	assert.equal(CONFIG_CHANNEL, CHANNEL);
	assert.deepEqual(h.events, [], "no shared-settings probes are needed");
	registerSettingsCommand(h.pi);
	assert.deepEqual([...h.commands.keys()], [COMMAND], "the same package can register again on reload");
	assert.ok(host().commands.has(COMMAND), "independent sessions get the command too");
});

test("text toggles and aliases write only this package's fields and preserve unknown data", async () => {
	await withFile(async (file) => {
		const h = host();
		for (let i = 0; i < WORDS.length; i++) await h.command.handler(WORDS[i] + " OFF", h.ctx);
		assert.deepEqual(readJson(file), { mine: "kept", ...Object.fromEntries(FIELDS.map((field) => [field, false])) });
		await h.command.handler("config " + WORDS[0] + " true", { mode: "print", hasUI: false, ui: {} });
		assert.equal(readJson(file)[FIELDS[0]], true);
		assert.ok(h.events.length > 0);
		assert.ok(h.events.every((event) => event.channel === CHANNEL), "only this package is notified");
	}, { mine: "kept" });
});

test("foreign settings, missing values and invalid booleans never change the file", async () => {
	await withFile(async (file) => {
		const h = host();
		const before = fs.readFileSync(file, "utf8");
		for (const input of [FOREIGN + " off", WORDS[0], WORDS[0] + " maybe", "__proto__ off", "constructor off", "help"]) {
			await h.command.handler(input, h.ctx);
			assert.equal(fs.readFileSync(file, "utf8"), before);
		}
		assert.deepEqual(h.events, []);
		assert.ok(h.notifications.at(-1).message.includes("Usage: /" + COMMAND));
	});
});

test("RPC gets only this package's summary and never opens TUI components", async () => {
	await withFile(async () => {
		const h = host();
		h.ctx.mode = "rpc";
		h.ctx.ui.custom = () => { throw new Error("RPC must not open the panel"); };
		await h.command.handler("", h.ctx);
		const summary = h.notifications.at(-1).message;
		assert.ok(summary.startsWith(TITLE + " settings"));
		assert.ok(summary.includes("Usage: /" + COMMAND));
		for (const word of WORDS) assert.ok(summary.includes("  " + word + ":"));
		assert.ok(!summary.includes("  " + FOREIGN + ":"));
	});
});

test("the single-page panel saves immediately, fits narrow terminals and closes on Esc", async () => {
	await withFile(async (file) => {
		const h = host(), ui = open(h);
		try {
			assert.ok(ui.screen().includes(TITLE));
			for (const label of LABELS) assert.ok(ui.screen().includes(label));
			assert.ok(!ui.screen().includes("Tab/Shift+Tab"));
			assert.equal(ui.options.blocked.kind, "question");
			for (const width of [0, 1, 6, 20, 40, 80, 150]) {
				for (const line of ui.panel.render(width)) assert.ok(visibleWidth(line) <= width, "line exceeds width " + width);
			}
			ui.panel.handleInput(" ");
			assert.equal(readJson(file)[FIELDS[0]], false);
			ui.panel.handleInput("\x1b[B");
			ui.panel.handleInput("\r");
			assert.equal(readJson(file)[FIELDS[1]], false);
			assert.ok(ui.renders() > 0);
			assert.deepEqual(h.notifications, [], "the panel itself shows changes, without chat notices");
			assert.ok(h.events.every((event) => event.channel === CHANNEL));
		} finally {
			ui.panel.handleInput("\x1b");
			await ui.closed;
		}
	});
});

test("environment overrides lock the panel but text commands can save a choice for later", async () => {
	await withFile(async (file) => {
		process.env[OVERRIDE] = "0";
		config.invalidateConfig();
		const h = host(), ui = open(h);
		try {
			assert.ok(ui.screen().includes(OVERRIDE + "=0 overrides this while set"));
			ui.panel.handleInput(" ");
			assert.deepEqual(readJson(file), {});
		} finally {
			ui.panel.handleInput("\x1b");
			await ui.closed;
		}
		await h.command.handler(WORDS[0] + " on", h.ctx);
		assert.equal(readJson(file)[FIELDS[0]], true);
		assert.equal(config.loadConfig()[FIELDS[0]], false);
		assert.equal(h.notifications.at(-1).level, "warning");
	});
});

test("a failed save rolls back inside real terminal input and emits no config change", async (t) => {
	await withFile(async (file, dir) => {
		const h = host();
		const tui = new TuiAltScreen({ columns: 100, rows: 30, write() {}, start() {}, stop() {}, hideCursor() {}, showCursor() {} }, false, dir);
		tui.requestRender = () => {};
		let component;
		h.ctx.ui.custom = (factory) => new Promise((resolve) => {
			component = factory(tui, { fg: (_role, text) => text, bold: (text) => text }, new KeybindingsManager(TUI_KEYBINDINGS, {}), resolve);
			tui.setFocus(component);
		});
		const closed = h.command.handler("", h.ctx);
		try {
			fs.chmodSync(dir, 0o500);
			try {
				const probe = path.join(dir, "probe");
				try { fs.writeFileSync(probe, "x"); fs.rmSync(probe); return t.skip("directory permissions do not restrict this user"); } catch {}
				tui.handleTerminalInput(" ");
				await assert.rejects(h.command.handler(WORDS[0] + " off", h.ctx), /EACCES/);
			} finally {
				fs.chmodSync(dir, 0o700);
			}
			assert.equal(h.notifications.at(-1).level, "error");
			assert.match(h.notifications.at(-1).message, /Could not save the setting/);
			assert.deepEqual(readJson(file), {});
			assert.equal(config.loadConfig()[FIELDS[0]], true);
			assert.ok(component.render(100).join("\n").includes(LABELS[0]));
			assert.deepEqual(h.events, []);
		} finally {
			fs.chmodSync(dir, 0o700);
			component.handleInput("\x1b");
			await closed;
			tui.stop();
		}
	});
});

test("a broken change listener cannot turn a successful save into a failed command", async () => {
	await withFile(async (file) => {
		const h = host();
		h.pi.events.emit = () => { throw new Error("broken listener"); };
		await h.command.handler(WORDS[0] + " off", h.ctx);
		assert.equal(readJson(file)[FIELDS[0]], false);
		assert.equal(h.notifications.at(-1).level, "info");
	});
});
