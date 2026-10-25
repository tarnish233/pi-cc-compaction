/**
 * The /pi_cc command: the settings every pi-cc package shares.
 *
 * This file is copied verbatim between pi-cc-loop, pi-cc-monitor,
 * pi-cc-plugins and pi-cc-compaction (separate npm packages); each repo's tests/shared.test.mjs
 * fails when the copies drift apart. The settings live in one pi-cc.json and
 * apply to every pi-cc package installed. A change is announced on the
 * "pi-cc:config" channel, so the packages repaint what the settings change
 * (loop and monitor both redraw the footer).
 *
 * Pi's /settings cannot take items from an extension (its panel is a fixed
 * list, and the command is handled before extension commands), so /pi_cc
 * opens its own, laid out like pi-cc-extensions' /ccstyle: one page per
 * plugin, a tab bar on top (Tab and Shift+Tab switch pages), and on each page
 * Pi's SettingsList with the selected setting's description below it.
 * Enter/Space changes a value; a change is saved at once and Esc closes.
 * Message style and the footer summary serve pi-cc-loop and pi-cc-monitor
 * alike, so the two share a page. A setting that an environment variable
 * overrides shows the value in effect and cannot be changed here; its
 * description names the variable. Outside the TUI, /pi_cc prints the summary,
 * page by page.
 *
 * Only one /pi_cc exists however many pi-cc packages are installed: Pi turns
 * same-named commands from different extensions into /pi_cc:1 and /pi_cc:2,
 * and plain /pi_cc then matches neither. The first pi-cc package to load
 * claims the command on a global symbol (extensions share one process), and
 * releases the claim at session shutdown, so /reload and pi-config changes
 * run the race again. The claim holds the owner's name, so a package
 * re-loading over its own claim re-claims it. The API offers no other way:
 * getCommands() cannot be called during loading.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, SettingsList, truncateToWidth, visibleWidth, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import { configPath, envOverride, loadConfig, saveConfig, type PiCcConfig } from "./config.ts";

/** Saved settings travel between the packages on this channel. */
export const CONFIG_CHANNEL = "pi-cc:config";

/** One /pi_cc per session: the first pi-cc package to load claims the name. */
const SLASH_CLAIM = Symbol.for("pi-cc:slash-command");

/** The part of Pi's theme the panel uses. */
export interface PanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface SettingSpec {
	field: keyof PiCcConfig;
	label: string;
	/** Display values for true and false. */
	on: string;
	off: string;
	description: string;
}

interface SettingsPage {
	label: string;
	settings: SettingSpec[];
}

const PAGES: SettingsPage[] = [
	{
		label: "Loop & Monitor",
		settings: [
			{
				field: "compactMessages",
				label: "Message style",
				on: "compact",
				off: "card",
				description:
					"How scheduled fires and Monitor events are drawn. compact: \u273b header and indented body; card: the old padded card.",
			},
			{
				field: "footer",
				label: "Footer summary",
				on: "on",
				off: "off",
				description: "One line in Pi's footer while loops or monitors run: loop 2 \u00b7 next 3m, monitor 2.",
			},
		],
	},
	{
		label: "Plugins",
		settings: [
			{
				field: "draft",
				label: "Draft recall",
				on: "on",
				off: "off",
				description: "Ctrl+C keeps what it clears; Up on the empty editor brings it back.",
			},
			{
				field: "turnSummary",
				label: "Turn summary",
				on: "on",
				off: "off",
				description: "One line closes every agent run \u2014 tools, duration, done time.",
			},
		],
	},
	{
		label: "Compact",
		settings: [
			{
				field: "compaction",
				label: "CC compaction",
				on: "on",
				off: "off",
				description:
					"Compaction summarizes the way Claude Code does \u2014 the same prompt and thresholds, reusing the prompt cache. off: Pi's own compaction.",
			},
			{
				field: "idleCompaction",
				label: "Idle compaction",
				on: "on",
				off: "off",
				description:
					"Compact while idle, before a prompt cache of an hour or more expires (Anthropic's 1h cache, or a model's promptCache).",
			},
		],
	},
];

const SETTINGS: SettingSpec[] = PAGES.flatMap((page) => page.settings);

/** Labels padded to one width, so the values stay in one column from page to page. */
const LABEL_WIDTH = Math.max(...SETTINGS.map((spec) => spec.label.length));

/**
 * Pi's getSettingsListTheme(), built from the theme the panel is given: the
 * global theme that function reads is not shared with extensions in every
 * Pi runtime.
 */
function listTheme(theme: PanelTheme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "\u2192 "),
		hint: (text) => theme.fg("dim", text),
	};
}

/** A path with the home directory shortened to ~. */
function displayPath(file: string): string {
	const home = os.homedir();
	return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function item(spec: SettingSpec): SettingItem {
	const value = loadConfig()[spec.field] ? spec.on : spec.off;
	const override = envOverride(spec.field);
	const label = spec.label.padEnd(LABEL_WIDTH);
	if (override) {
		// No values: Enter/Space leaves it alone, and the description says why.
		return {
			id: spec.field,
			label,
			currentValue: value,
			description: `${spec.description}\n${override} overrides this while set; unset it to change it here.`,
		};
	}
	return { id: spec.field, label, currentValue: value, values: [spec.on, spec.off], description: spec.description };
}

export interface SettingsPanelOptions {
	theme: PanelTheme;
	/** Where the settings are saved, shown in the title. */
	file: string;
	/** Save one setting (and tell the other packages). */
	onChange(field: keyof PiCcConfig, value: boolean): void;
	onClose(): void;
}

export interface SettingsPanel {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

const HINT = "  Enter/Space to change \u00b7 Tab/Shift+Tab to switch pages \u00b7 Esc to close";

function isNextPageKey(data: string): boolean {
	return data === "\t" || matchesKey(data, "tab");
}

function isPreviousPageKey(data: string): boolean {
	// CSI Z is how most terminals send Shift+Tab.
	return data === "\x1b[Z" || matchesKey(data, "shift+tab");
}

export function settingsPanel(options: SettingsPanelOptions): SettingsPanel {
	const { theme } = options;
	const lists = PAGES.map((page) => {
		const list: SettingsList = new SettingsList(
			page.settings.map(item),
			page.settings.length,
			listTheme(theme),
			(id, value) => {
				const spec = page.settings.find((candidate) => candidate.field === id);
				if (!spec) return;
				options.onChange(spec.field, value === spec.on);
				// Show what is in effect now.
				list.updateValue(id, loadConfig()[spec.field] ? spec.on : spec.off);
			},
			() => options.onClose(),
		);
		return list;
	});
	let active = 0;

	const rule = (width: number) => theme.fg("dim", "\u2500".repeat(Math.max(0, width)));
	const tabBar = (width: number) => {
		const tabs = PAGES.map((page, index) =>
			index === active ? theme.fg("text", theme.bold(page.label)) : theme.fg("dim", page.label),
		).join(theme.fg("dim", " / "));
		// The file the settings are saved in, on the right when it fits.
		const file = displayPath(options.file);
		const gap = width - visibleWidth(tabs) - visibleWidth(file);
		return gap >= 2 ? `${tabs}${" ".repeat(gap)}${theme.fg("dim", file)}` : truncateToWidth(tabs, width);
	};
	/** The open page's list, without SettingsList's own hint: the panel has one below. */
	const body = (width: number) => {
		const lines = lists[active].render(width);
		const hint = lines.findIndex((line) => line.includes("Esc to cancel"));
		const kept = hint === -1 ? lines : lines.slice(0, hint);
		while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
		return kept;
	};

	return {
		render: (width) => {
			const safe = Math.max(0, Math.floor(width));
			return [rule(safe), tabBar(safe), rule(safe), ...body(safe), rule(safe), truncateToWidth(theme.fg("dim", HINT), safe), rule(safe)];
		},
		invalidate: () => {
			for (const list of lists) list.invalidate();
		},
		handleInput: (data) => {
			if (isNextPageKey(data)) active = (active + 1) % PAGES.length;
			else if (isPreviousPageKey(data)) active = (active - 1 + PAGES.length) % PAGES.length;
			else lists[active].handleInput(data);
		},
	};
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	} catch {
		// a stale context must never break the command
	}
}

/** ` (PI_CC_FOOTER=0)` when an environment variable decides the setting. */
function overrideNote(key: keyof PiCcConfig): string {
	const override = envOverride(key);
	return override ? ` (${override})` : "";
}

function showSettings(ctx: ExtensionContext): void {
	const config = loadConfig();
	const lines = [
		`pi-cc settings \u00b7 ${configPath()}`,
		PAGES[0].label,
		`  messages:  ${config.compactMessages ? "compact" : "card"}${overrideNote("compactMessages")}`,
		`  footer:    ${config.footer ? "summary" : "hidden"}${overrideNote("footer")}`,
		PAGES[1].label,
		`  draft:     ${config.draft ? "on" : "off"}${overrideNote("draft")}`,
		`  summary:   ${config.turnSummary ? "on" : "off"}${overrideNote("turnSummary")}`,
		PAGES[2].label,
		`  compact:   ${config.compaction ? "on" : "off"}${overrideNote("compaction")}`,
		`  idle:      ${config.idleCompaction ? "on" : "off"}${overrideNote("idleCompaction")}`,
		"",
		"Usage: /pi_cc messages on|off",
		"       /pi_cc footer on|off",
		"       /pi_cc draft on|off",
		"       /pi_cc summary on|off",
		"       /pi_cc compact on|off",
		"       /pi_cc idle on|off",
	];
	notify(ctx, lines.join("\n"), "info");
}

/** Save one setting and tell every pi-cc package; each repaints itself. Returns the settings in effect. */
type ApplySetting = (field: keyof PiCcConfig, on: boolean) => PiCcConfig;

/**
 * A bare /pi_cc in the TUI: a panel like Pi's /settings, which extensions
 * cannot add to. Resolves when the panel closes; false when there is no TUI
 * to show it in, so the caller prints the summary instead.
 */
async function openSettingsPanel(ctx: ExtensionCommandContext, apply: ApplySetting): Promise<boolean> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return false;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const panel = settingsPanel({
			theme,
			file: configPath(),
			onChange: (field, value) => {
				apply(field, value);
			},
			onClose: () => done(undefined),
		});
		return {
			render: (width: number) => panel.render(width),
			invalidate: () => panel.invalidate(),
			handleInput: (data: string) => {
				panel.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return true;
}

/** The command word for each setting: the field it writes and its notice label. */
const KEYS: Record<string, { field: keyof PiCcConfig; label: string }> = {
	messages: { field: "compactMessages", label: "Compact message style" },
	message: { field: "compactMessages", label: "Compact message style" },
	footer: { field: "footer", label: "Footer summary" },
	status: { field: "footer", label: "Footer summary" },
	statusline: { field: "footer", label: "Footer summary" },
	draft: { field: "draft", label: "Draft recall" },
	summary: { field: "turnSummary", label: "Turn summary" },
	turnsummary: { field: "turnSummary", label: "Turn summary" },
	compact: { field: "compaction", label: "CC compaction" },
	compaction: { field: "compaction", label: "CC compaction" },
	idle: { field: "idleCompaction", label: "Idle compaction" },
};

function setSetting(ctx: ExtensionContext, apply: ApplySetting, key: string, raw: string | undefined): void {
	const spec = KEYS[key];
	if (!spec) {
		showSettings(ctx);
		return;
	}
	const value = (raw ?? "").toLowerCase();
	const on = value === "on" || value === "true" || value === "1";
	const off = value === "off" || value === "false" || value === "0";
	if (!on && !off) {
		showSettings(ctx);
		return;
	}
	const field = spec.field;
	const next = apply(field, on);
	const override = envOverride(field);
	if (override && next[field] !== on) {
		// The file has the choice, but the variable decides while it is set.
		notify(ctx, `${spec.label} saved as ${on ? "on" : "off"}, but ${override} overrides it while set`, "warning");
	} else {
		notify(ctx, `${spec.label} ${on ? "enabled" : "disabled"}`, "info");
	}
}

/**
 * Register /pi_cc on behalf of one pi-cc package. The first package to load
 * wins; the others leave the command to it, so there is never a /pi_cc:2.
 */
export function registerPiCcCommand(pi: ExtensionAPI, owner: string): void {
	const claims = globalThis as typeof globalThis & Record<symbol, string | undefined>;
	if (claims[SLASH_CLAIM] !== undefined && claims[SLASH_CLAIM] !== owner) return;
	claims[SLASH_CLAIM] = owner;
	// Release the name when this session ends, so /reload re-runs the race.
	pi.on("session_shutdown", () => {
		if (claims[SLASH_CLAIM] === owner) claims[SLASH_CLAIM] = undefined;
	});

	const applySetting: ApplySetting = (field, on) => {
		const patch: Partial<PiCcConfig> = { [field]: on };
		const next = saveConfig(patch);
		try {
			pi.events.emit(CONFIG_CHANNEL, next);
		} catch {
			// another extension must not break the command
		}
		return next;
	};

	pi.registerCommand("pi_cc", {
		description: "pi-cc settings: message style, footer, draft, turn summary, compaction",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			// "/pi_cc settings footer on" reads like the old /loop settings: drop the noun.
			if (words[0] === "settings" || words[0] === "config") words.shift();
			if (words.length === 0) {
				if (!(await openSettingsPanel(ctx, applySetting))) showSettings(ctx);
				return;
			}
			// "/pi_cc help", or a word that is not a setting: the summary says what is.
			const key = words[0].toLowerCase();
			if (key === "help" || !KEYS[key]) {
				showSettings(ctx);
				return;
			}
			setSetting(ctx, applySetting, key, words[1]);
		},
	});
}
