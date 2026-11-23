import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall, loadModule } from "./helpers.mjs";

process.env.PI_CC_CONFIG_FILE ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-settings-render-")), "pi-cc.json");
const { settingsPanel } = await loadModule("settings.ts");
const { SettingsList } = await import(pathToFileURL(findPiInstall().piTui).href);
const theme = { fg: (_role, text) => text, bold: text => text };

for (const [label, rows] of [
	["without a hint", ["cached setting", " ", ""]],
	["with a hint", ["cached setting", "", "Esc to cancel", "unused footer"]],
]) {
	test(`settings trim their own copy, not Pi's cached rows (${label})`, (t) => {
		const cached = Object.freeze(rows);
		const render = t.mock.method(SettingsList.prototype, "render", () => cached);
		const panel = settingsPanel({ theme, file: process.env.PI_CC_CONFIG_FILE, onChange() {}, onClose() {} });
		const first = panel.render(80);
		assert.ok(first.includes("cached setting"));
		assert.deepEqual(panel.render(80), first, "repeated frames must leave the native cache unchanged");
		assert.deepEqual(cached, rows);
		assert.ok(render.mock.calls.length >= 2, "the frozen native render result was exercised");
	});
}
