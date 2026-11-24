/**
 * /compaction_settings opens only this package's settings. Text arguments also work in
 * RPC mode. Values are saved immediately; a failed save restores the value
 * still in effect. Environment overrides are shown but cannot be toggled.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, visibleWidth, type SettingItem, type SettingsListTheme } from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import { configPath, envOverride, loadConfig, saveConfig, type PiCcConfig } from "./config.ts";

export const CONFIG_CHANNEL = "pi-cc-compaction:config";
const COMMAND = "compaction_settings";
const TITLE = "Compaction";

export interface PanelTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface SettingSpec {
	field: keyof PiCcConfig;
	label: string;
	on: string;
	off: string;
	description: string;
}

const SETTINGS: SettingSpec[] = [
	{
		field: "compaction",
		label: "CC compaction",
		on: "on",
		off: "off",
		description: "Compaction summarizes the way Claude Code does — the same prompt and thresholds, reusing the prompt cache. off: Pi's own compaction.",
	},
	{
		field: "idleCompaction",
		label: "Idle compaction",
		on: "on",
		off: "off",
		description: "Compact while idle, before a prompt cache of an hour or more expires (Anthropic's 1h cache, or a model's promptCache).",
	},
];

const KEYS: Record<string, keyof PiCcConfig> = {
	compact: "compaction",
	compaction: "compaction",
	idle: "idleCompaction",
};

const LABEL_WIDTH = Math.max(...SETTINGS.map((spec) => spec.label.length));
const HINT = "  Enter/Space to change · Esc to close";

/** Use the injected theme, not another module's global theme. */
function listTheme(theme: PanelTheme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}

function displayPath(file: string): string {
	const home = os.homedir();
	return file === home || file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

function settingValue(spec: SettingSpec): string {
	return loadConfig()[spec.field] ? spec.on : spec.off;
}

function item(spec: SettingSpec): SettingItem {
	const currentValue = settingValue(spec);
	const override = envOverride(spec.field);
	const label = spec.label.padEnd(LABEL_WIDTH);
	if (override) {
		return {
			id: spec.field,
			label,
			currentValue,
			description: `${spec.description}\n${override} overrides this while set; unset it to change it here.`,
		};
	}
	return { id: spec.field, label, currentValue, values: [spec.on, spec.off], description: spec.description };
}

export interface SettingsPanelOptions {
	theme: PanelTheme;
	file: string;
	onChange(field: keyof PiCcConfig, value: string): void;
	onClose(): void;
}

export interface SettingsPanel {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

export function settingsPanel(options: SettingsPanelOptions): SettingsPanel {
	const { theme } = options;
	const list: SettingsList = new SettingsList(
		SETTINGS.map(item),
		SETTINGS.length,
		listTheme(theme),
		(id, value) => {
			const spec = SETTINGS.find((candidate) => candidate.field === id);
			if (!spec) return;
			options.onChange(spec.field, value);
			list.updateValue(id, settingValue(spec));
		},
		() => options.onClose(),
	);
	const rule = (width: number) => theme.fg("dim", "─".repeat(width));
	const heading = (width: number) => {
		const title = theme.fg("text", theme.bold(TITLE));
		const file = displayPath(options.file);
		const gap = width - visibleWidth(title) - visibleWidth(file);
		return gap >= 2 ? `${title}${" ".repeat(gap)}${theme.fg("dim", file)}` : truncateToWidth(title, width);
	};
	const body = (width: number) => {
		const lines = list.render(width);
		const hint = lines.findIndex((line) => line.includes("Esc to cancel"));
		// Native render arrays may be cached and frozen; trim only our copy.
		const kept = hint === -1 ? [...lines] : lines.slice(0, hint);
		while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
		return kept;
	};
	return {
		render: (width) => {
			const safe = Math.max(0, Math.floor(width));
			return [rule(safe), heading(safe), rule(safe), ...body(safe), rule(safe), theme.fg("dim", HINT), rule(safe)]
				.map((line) => truncateToWidth(line, safe));
		},
		invalidate: () => list.invalidate(),
		handleInput: (data) => list.handleInput(data),
	};
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	} catch {
		// A stale context must never break the command.
	}
}

function commandWord(field: keyof PiCcConfig): string {
	return Object.keys(KEYS).find((word) => KEYS[word] === field) ?? field;
}

function showSettings(ctx: ExtensionContext): void {
	const lines = [`${TITLE} settings · ${configPath()}`];
	for (const spec of SETTINGS) {
		const override = envOverride(spec.field);
		lines.push(`  ${commandWord(spec.field)}:`.padEnd(13) + settingValue(spec) + (override ? ` (${override})` : ""));
	}
	lines.push("", `Usage: /${COMMAND} <item> on|off  (${SETTINGS.map((spec) => commandWord(spec.field)).join(", ")})`);
	notify(ctx, lines.join("\n"));
}

type ApplySetting = (field: keyof PiCcConfig, value: string) => void;

async function openSettingsPanel(ctx: ExtensionCommandContext, apply: ApplySetting): Promise<boolean> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return false;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const panel = settingsPanel({
			theme,
			file: configPath(),
			onChange: (field, value) => {
				// Terminal input has no error boundary; a failed save must not escape.
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
	}, { blocked: { kind: "question", message: `Changing ${TITLE} settings` } });
	return true;
}

function setSetting(ctx: ExtensionContext, apply: ApplySetting, key: string, raw: string | undefined): void {
	const field = KEYS[key];
	const spec = SETTINGS.find((candidate) => candidate.field === field);
	if (!spec || raw === undefined) {
		showSettings(ctx);
		return;
	}
	const input = raw.trim().toLowerCase();
	const value = input === "on" || input === "true" || input === "1" ? spec.on
		: input === "off" || input === "false" || input === "0" ? spec.off
		: undefined;
	if (value === undefined) {
		showSettings(ctx);
		return;
	}
	apply(field, value);
	const override = envOverride(field);
	if (override && settingValue(spec) !== value) {
		notify(ctx, `${spec.label} saved as ${value}, but ${override} overrides it while set`, "warning");
	} else {
		notify(ctx, `${spec.label} ${value === spec.on ? "enabled" : "disabled"}`);
	}
}

export function registerSettingsCommand(pi: ExtensionAPI): void {
	const applySetting: ApplySetting = (field, value) => {
		const spec = SETTINGS.find((candidate) => candidate.field === field);
		const next = saveConfig({ [field]: value === spec?.on });
		try {
			pi.events.emit(CONFIG_CHANNEL, next);
		} catch {
			// Another listener must not turn a saved setting into a failed command.
		}
	};
	pi.registerCommand(COMMAND, {
		description: `${TITLE} settings: ${SETTINGS.map((spec) => spec.label.toLowerCase()).join(", ")}`,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			if (words[0] === "settings" || words[0] === "config") words.shift();
			if (words.length === 0) {
				if (!(await openSettingsPanel(ctx, applySetting))) showSettings(ctx);
				return;
			}
			setSetting(ctx, applySetting, words[0].toLowerCase(), words[1]);
		},
	});
}
