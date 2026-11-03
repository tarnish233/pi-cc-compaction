/**
 * The Pi internals this package patches, checked against the Pi it runs on.
 *
 * patches.ts wraps `SettingsManager.prototype.getCompactionSettings` and
 * `ExtensionRunner.prototype.emitBeforeProviderRequest`, and uses
 * `ExtensionRunner.prototype.invalidate` for SDK sessions. The wrappers return
 * Pi's own behaviour when the target is gone, so a rename in a Pi release would
 * quietly put Pi's compaction thresholds back instead of failing. This test fails
 * on the day that release is installed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall } from "./helpers.mjs";

const install = findPiInstall();
const { ExtensionRunner, SettingsManager } = await import(pathToFileURL(install.piCodingAgent).href);

/** prototype → methods patches.ts wraps. */
const PATCHES = [
	["SettingsManager", SettingsManager, ["getCompactionSettings"]],
	["ExtensionRunner", ExtensionRunner, ["emitBeforeProviderRequest", "invalidate"]],
];

test("every Pi internal pi-cc-compaction patches is still there", () => {
	const missing = [];
	for (const [label, klass, methods] of PATCHES) {
		for (const method of methods) {
			if (typeof klass?.prototype?.[method] !== "function") missing.push(`${label}.${method}`);
		}
	}
	assert.deepEqual(missing, [], `Pi ${install.version}: the patch targets changed; update patches.ts`);
});