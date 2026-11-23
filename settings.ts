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
 * loaded plugin, a tab bar on top (Tab and Shift+Tab switch pages), and on each page
 * Pi's SettingsList with the selected setting's description below it.
 * Enter/Space changes a value; a change is saved at once and Esc closes.
 * Message style and the footer summary serve pi-cc-loop and pi-cc-monitor
 * alike, so the two share a page. A setting that an environment variable
 * overrides shows the value in effect and cannot be changed here; its
 * description names the variable. Outside the TUI, /pi_cc prints the summary
 * for the same loaded-package pages.
 *
 * Only one /pi_cc exists per session however many pi-cc packages are installed:
 * Pi turns same-named commands from different extensions into /pi_cc:1 and
 * /pi_cc:2, and plain /pi_cc then matches neither. The first package claims the
 * command through the session's event bus and releases the claim at shutdown.
 * The bus is shared by extension facades in one runtime but isolated between
 * independent SDK sessions, unlike a process-global symbol. The claim holds
 * live owner tokens, so a package re-loading over its own claim can re-register
 * without letting an older instance release a newer one's ownership.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, SettingsList, truncateToWidth, visibleWidth, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import { configPath, DEFAULT_CONFIG, envOverride, loadConfig, saveConfig, type PiCcConfig } from "./config.ts";

/** Saved settings travel between the packages on this channel. */
export const CONFIG_CHANNEL = "pi-cc:config";

/** Synchronous per-runtime discovery, the same pattern used by the shared /tasks panel. */
const SETTINGS_PROBE_CHANNEL = "pi-cc:settings:probe";

interface SettingsRegistry {
	/** Live command-owner token -> package name. Only one package name may claim a runtime. */
	owners: Map<object, string>;
	/** Every loaded package, including packages that did not win the command. */
	packages: Map<object, string>;
	probeListener?: () => void;
	disposed: boolean;
}

interface SettingsProbe {
	reply(registry: SettingsRegistry): void;
}

function findSettingsRegistry(pi: ExtensionAPI): SettingsRegistry | undefined {
	let found: SettingsRegistry | undefined;
	try {
		pi.events.emit(SETTINGS_PROBE_CHANNEL, {
			reply: (registry: SettingsRegistry) => {
				if (!found && registry && !registry.disposed) found = registry;
			},
		} satisfies SettingsProbe);
	} catch {
		// A missing bus only means this package stands alone.
	}
	return found;
}

function disposeSettingsRegistry(registry: SettingsRegistry): void {
	if (registry.disposed) return;
	registry.disposed = true;
	registry.owners.clear();
	registry.packages?.clear();
	try {
		registry.probeListener?.();
	} catch {
		// the runtime may already have unsubscribed it
	}
	registry.probeListener = undefined;
}

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
					"How scheduled fires and Monitor events are drawn. compact: one collapsed line, expandable details; card: the legacy padded card.",
			},
			{
				field: "footer",
				label: "Footer summary",
				on: "on",
				off: "off",
				description: "One line in Pi's footer while loops or monitors run: 1 loop \u00b7 next 3m, 2 monitors.",
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
			{
				field: "ccKeys",
				label: "CC keys",
				on: "on",
				off: "off",
				description:
					"Up on the empty prompt recalls a queued message and Down puts the prompt back. Enter keeps Pi's keys (steer while running, send when idle).",
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

function pagesForPackages(packages: ReadonlySet<string>): SettingsPage[] {
	const pages = PAGES.filter((page) => {
		if (page.label === "Loop & Monitor") return packages.has("pi-cc-loop") || packages.has("pi-cc-monitor");
		if (page.label === "Plugins") return packages.has("pi-cc-plugins");
		if (page.label === "Compact") return packages.has("pi-cc-compaction");
		return true;
	});
	return pages.length ? pages : PAGES;
}

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

function settingValue(spec: SettingSpec): string {
	return loadConfig()[spec.field] ? spec.on : spec.off;
}

function item(spec: SettingSpec): SettingItem {
	const value = settingValue(spec);
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
	/** Loaded-package pages supplied by /pi_cc; direct callers default to all pages. */
	pages?: SettingsPage[];
	/** Where the settings are saved, shown in the title. */
	file: string;
	/** Save one setting (and tell the other packages). */
	onChange(field: keyof PiCcConfig, value: string): void;
	onClose(): void;
}

export interface SettingsPanel {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

const HINT = "  Enter/Space to change \u00b7 Tab/Shift+Tab to switch pages \u00b7 Esc to close";
const SINGLE_PAGE_HINT = "  Enter/Space to change \u00b7 Esc to close";

function isNextPageKey(data: string): boolean {
	return data === "\t" || matchesKey(data, "tab");
}

function isPreviousPageKey(data: string): boolean {
	// CSI Z is how most terminals send Shift+Tab.
	return data === "\x1b[Z" || matchesKey(data, "shift+tab");
}

export function settingsPanel(options: SettingsPanelOptions): SettingsPanel {
	const { theme } = options;
	const pages = options.pages?.length ? options.pages : PAGES;
	const lists = pages.map((page) => {
		const list: SettingsList = new SettingsList(
			page.settings.map(item),
			page.settings.length,
			listTheme(theme),
			(id, value) => {
				const spec = page.settings.find((candidate) => candidate.field === id);
				if (!spec) return;
				options.onChange(spec.field, value);
				// Show what is in effect now.
				list.updateValue(id, settingValue(spec));
			},
			() => options.onClose(),
		);
		return list;
	});
	let active = 0;

	const rule = (width: number) => theme.fg("dim", "\u2500".repeat(Math.max(0, width)));
	const tabBar = (width: number) => {
		const tabs = pages.map((page, index) =>
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
		const kept = hint === -1 ? [...lines] : lines.slice(0, hint);
		while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
		return kept;
	};

	return {
		render: (width) => {
			const safe = Math.max(0, Math.floor(width));
			const hint = pages.length > 1 ? HINT : SINGLE_PAGE_HINT;
			return [rule(safe), tabBar(safe), rule(safe), ...body(safe), rule(safe), truncateToWidth(theme.fg("dim", hint), safe), rule(safe)];
		},
		invalidate: () => {
			for (const list of lists) list.invalidate();
		},
		handleInput: (data) => {
			if (pages.length > 1 && isNextPageKey(data)) active = (active + 1) % pages.length;
			else if (pages.length > 1 && isPreviousPageKey(data)) active = (active - 1 + pages.length) % pages.length;
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

/**
 * The word the text summary uses for a setting: the first alias in KEYS. The
 * panel shows the description label instead.
 */
function commandWord(field: keyof PiCcConfig): string {
	return Object.keys(KEYS).find((word) => KEYS[word].field === field) ?? field;
}

/**
 * The summary a non-TUI /pi_cc prints, generated from the same pages the panel
 * draws: a setting added to PAGES cannot go missing here.
 */
function showSettings(ctx: ExtensionContext, pages = PAGES): void {
	const lines = [`pi-cc settings \u00b7 ${configPath()}`];
	const settings = pages.flatMap((page) => page.settings);
	for (const page of pages) {
		lines.push(page.label);
		for (const spec of page.settings) {
			const value = settingValue(spec);
			lines.push(`  ${commandWord(spec.field)}:`.padEnd(13) + value + overrideNote(spec.field));
		}
	}
	lines.push(
		"",
		`Usage: /pi_cc <item> <value>  (${settings.map((spec) => commandWord(spec.field)).join(", ")})`,
	);
	notify(ctx, lines.join("\n"), "info");
}

/** Save one setting and tell every pi-cc package; each repaints itself. Returns the settings in effect. */
type ApplySetting = (field: keyof PiCcConfig, value: string) => PiCcConfig;

/**
 * A bare /pi_cc in the TUI: a panel like Pi's /settings, which extensions
 * cannot add to. Resolves when the panel closes; false when there is no TUI
 * to show it in, so the caller prints the summary instead.
 */
async function openSettingsPanel(ctx: ExtensionCommandContext, apply: ApplySetting, pages = PAGES): Promise<boolean> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return false;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const panel = settingsPanel({
			theme,
			pages,
			file: configPath(),
			onChange: (field, value) => {
				// The panel restores the value in effect right after this callback;
				// a failed save must not escape through handleTerminalInput and crash Pi.
				try {
					apply(field, value);
				} catch (error) {
					notify(ctx, `Could not save the setting: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
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
	}, {
		// Inline screen: tell the terminal (OSC 7501) Pi is waiting on the user.
		blocked: { kind: "question", message: "Changing extension settings" },
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
	keys: { field: "ccKeys", label: "CC keys" },
	keymap: { field: "ccKeys", label: "CC keys" },
	compact: { field: "compaction", label: "CC compaction" },
	compaction: { field: "compaction", label: "CC compaction" },
	idle: { field: "idleCompaction", label: "Idle compaction" },
};

function setSetting(ctx: ExtensionContext, apply: ApplySetting, key: string, raw: string | undefined, pages = PAGES): void {
	const spec = KEYS[key];
	if (!spec) {
		showSettings(ctx, pages);
		return;
	}
	const setting = SETTINGS.find((candidate) => candidate.field === spec.field);
	if (!setting || raw === undefined) {
		showSettings(ctx, pages);
		return;
	}
	const input = raw.trim().toLowerCase();
	const value = input === "on" || input === "true" || input === "1" ? setting.on
		: input === "off" || input === "false" || input === "0" ? setting.off
		: undefined;
	if (value === undefined) {
		showSettings(ctx, pages);
		return;
	}
	const field = spec.field;
	const next = apply(field, value);
	const override = envOverride(field);
	if (override && settingValue(setting) !== value) {
		// The file has the choice, but the variable decides while it is set.
		notify(ctx, `${spec.label} saved as ${value}, but ${override} overrides it while set`, "warning");
	} else {
		notify(ctx, `${spec.label} ${value === setting.on ? "enabled" : "disabled"}`, "info");
	}
}

/**
 * Register /pi_cc on behalf of one pi-cc package. The first package in this
 * runtime wins; independent sessions have independent buses and each get the
 * command. A same-package reload may register alongside its previous instance.
 */
export function registerPiCcCommand(pi: ExtensionAPI, owner: string): void {
	let registry = findSettingsRegistry(pi);
	if (!registry) {
		const created: SettingsRegistry = { owners: new Map(), packages: new Map(), disposed: false };
		registry = created;
		created.probeListener = pi.events.on(SETTINGS_PROBE_CHANNEL, (data) => {
			if (created.disposed) return;
			try {
				(data as SettingsProbe | undefined)?.reply?.(created);
			} catch {
				// a broken prober must not affect the registry
			}
		});
	}
	// A mixed-version runtime may have created the registry before package
	// capabilities existed. Preserve its owner information while upgrading it.
	const packages = registry.packages ??= new Map();
	for (const packageName of registry.owners.values()) {
		if (![...packages.values()].includes(packageName)) packages.set({}, packageName);
	}
	const capabilityToken = {};
	packages.set(capabilityToken, owner);
	const claimedBy = new Set(registry.owners.values());
	const canOwn = claimedBy.size === 0 || claimedBy.has(owner);
	const token = canOwn ? {} : undefined;
	if (token) registry.owners.set(token, owner);
	pi.on("session_shutdown", () => {
		registry.packages.delete(capabilityToken);
		if (!token) return;
		registry.owners.delete(token);
		// Same-owner instances may overlap during reload. The last live token
		// releases discovery; one instance can never release another's claim.
		if (!registry.owners.size) disposeSettingsRegistry(registry);
	});
	if (!canOwn) return;

	const applySetting: ApplySetting = (field, value) => {
		const setting = SETTINGS.find((candidate) => candidate.field === field);
		const stored = value === setting?.on;
		const patch = { [field]: stored } as Partial<PiCcConfig>;
		const next = saveConfig(patch);
		try {
			pi.events.emit(CONFIG_CHANNEL, next);
		} catch {
			// another extension must not break the command
		}
		return next;
	};

	pi.registerCommand("pi_cc", {
		description: "pi-cc settings: message style, footer, draft, turn summary, CC keys, compaction",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const pages = pagesForPackages(new Set(registry.packages.values()));
			const words = args.trim().split(/\s+/).filter(Boolean);
			// "/pi_cc settings footer on" reads like the old /loop settings: drop the noun.
			if (words[0] === "settings" || words[0] === "config") words.shift();
			if (words.length === 0) {
				if (!(await openSettingsPanel(ctx, applySetting, pages))) showSettings(ctx, pages);
				return;
			}
			// "/pi_cc help", or a word that is not a setting: the summary says what is.
			const key = words[0].toLowerCase();
			if (key === "help" || !KEYS[key]) {
				showSettings(ctx, pages);
				return;
			}
			setSetting(ctx, applySetting, key, words[1], pages);
		},
	});
}
