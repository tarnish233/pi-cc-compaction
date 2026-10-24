/**
 * The files copied verbatim between the pi-cc packages (they are separate npm
 * packages): config.ts and settings.ts in all four, render.ts in pi-cc-loop
 * and pi-cc-monitor. This test fails when the copies drift apart; each
 * comparison is skipped when that sibling checkout is missing.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { extensionDir, siblingExtensionDir } from "./helpers.mjs";

const self = path.basename(extensionDir);
const SIBLINGS = ["pi-cc-loop", "pi-cc-monitor", "pi-cc-plugins", "pi-cc-compact"].filter((name) => name !== self);
/** Which packages carry which shared file. */
const SHARED = {
	"config.ts": SIBLINGS,
	"settings.ts": SIBLINGS,
	"render.ts": SIBLINGS.filter((name) => name !== "pi-cc-plugins" && name !== "pi-cc-compact"),
};

for (const [file, siblings] of Object.entries(SHARED)) {
	// pi-cc-plugins and pi-cc-compact carry no render.ts: they render nothing
	// from the shared settings, so the file being absent there is not drift.
	if (!fs.existsSync(path.join(extensionDir, file))) continue;
	for (const sibling of siblings) {
		const theirs = siblingExtensionDir(sibling);
		const present = fs.existsSync(path.join(theirs, "package.json"));
		test(`${file} is identical in ${self} and ${sibling}`, { skip: !present && "sibling checkout not found" }, () => {
			const mine = fs.readFileSync(path.join(extensionDir, file), "utf8");
			const theirsFile = fs.readFileSync(path.join(theirs, file), "utf8");
			assert.ok(mine === theirsFile, `${file} differs from ${path.join(theirs, file)}; copy the newer one over`);
		});
	}
}
