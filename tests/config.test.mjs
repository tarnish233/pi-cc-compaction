const FIELDS = ["compaction","idleCompaction"];
const FILE_NAME = "pi-cc-compaction.json";
const OVERRIDE = "PI_CC_COMPACTION";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const config = await loadModule("config.ts");
const ownValues = (value) => Object.fromEntries(FIELDS.map((field) => [field, value]));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

async function isolated(body, explicit = false) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "independent-settings-"));
	const file = path.join(dir, explicit ? "explicit.json" : FILE_NAME);
	const env = { PI_CODING_AGENT_DIR: dir, PI_CC_CONFIG_FILE: explicit ? file : undefined, [OVERRIDE]: undefined };
	const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		config.invalidateConfig();
		return await body({ dir, file, legacy: path.join(dir, "pi-cc.json") });
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		config.invalidateConfig();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("the default file and schema belong only to this extension", async () => {
	await isolated(({ file }) => {
		assert.equal(config.configPath(), file);
		assert.deepEqual(config.DEFAULT_CONFIG, ownValues(true));
		assert.deepEqual(config.loadConfig(), ownValues(true));
		assert.equal(fs.existsSync(file), false, "loading settings does not write a file");
	});
});

test("legacy choices are inherited and copied only for this extension on its first save", async () => {
	await isolated(({ file, legacy }) => {
		const old = JSON.stringify({ ...ownValues(false), foreignFlag: true, futureSetting: "kept" }, null, 2);
		fs.writeFileSync(legacy, old);
		assert.deepEqual(config.loadConfig(), ownValues(false));
		assert.equal(fs.existsSync(file), false, "migration waits for an explicit save");
		process.env[OVERRIDE] = "1";
		config.invalidateConfig();
		config.saveConfig({ [FIELDS[1]]: true });
		assert.deepEqual(readJson(file), { ...ownValues(false), [FIELDS[1]]: true }, "environment values and foreign keys are not migrated");
		assert.equal(fs.readFileSync(legacy, "utf8"), old, "the old file is never changed or deleted");
	});
});

test("an existing independent file wins and a save preserves its unknown keys", async () => {
	await isolated(({ file, legacy }) => {
		fs.writeFileSync(legacy, JSON.stringify(ownValues(false)));
		const current = { [FIELDS[0]]: true, mine: "keep me" };
		fs.writeFileSync(file, JSON.stringify(current));
		assert.deepEqual(config.loadConfig(), ownValues(true), "missing fields in the new file use defaults, not the old file");
		config.saveConfig({ [FIELDS[1]]: false });
		assert.deepEqual(readJson(file), { ...current, [FIELDS[1]]: false });
		assert.deepEqual(readJson(legacy), ownValues(false));
	});
});

test("an explicit config path is isolated from both default files and legacy settings", async () => {
	await isolated(({ dir, file, legacy }) => {
		fs.writeFileSync(legacy, JSON.stringify(ownValues(false)));
		assert.equal(config.configPath(), file);
		assert.deepEqual(config.loadConfig(), ownValues(true));
		config.saveConfig({ [FIELDS[0]]: false });
		assert.deepEqual(readJson(file), { [FIELDS[0]]: false });
		assert.equal(fs.existsSync(path.join(dir, FILE_NAME)), false);
	}, true);
});

test("valid environment overrides win but are never persisted; malformed values use defaults", async () => {
	await isolated(({ file }) => {
		fs.writeFileSync(file, JSON.stringify({ [FIELDS[0]]: false, [FIELDS[1]]: "invalid" }));
		process.env[OVERRIDE] = "on";
		config.invalidateConfig();
		assert.equal(config.loadConfig()[FIELDS[0]], true);
		assert.equal(config.loadConfig()[FIELDS[1]], true);
		config.saveConfig({ [FIELDS[1]]: false });
		assert.deepEqual(readJson(file), { [FIELDS[0]]: false, [FIELDS[1]]: false });
		process.env[OVERRIDE] = "invalid";
		config.invalidateConfig();
		assert.equal(config.envOverride(FIELDS[0]), undefined);
		assert.equal(config.loadConfig()[FIELDS[0]], false);
	});
});

test("an unreadable new file is never overwritten", async (t) => {
	await isolated(({ file }) => {
		const bytes = JSON.stringify({ ...ownValues(true), futureSetting: "must survive" });
		fs.writeFileSync(file, bytes);
		fs.chmodSync(file, 0o200);
		try {
			try { fs.readFileSync(file, "utf8"); return t.skip("file permissions do not restrict this user"); } catch (error) {
				assert.equal(error.code, "EACCES");
			}
			assert.throws(() => config.saveConfig({ [FIELDS[0]]: false }), (error) => error.code === "EACCES");
		} finally {
			fs.chmodSync(file, 0o600);
		}
		assert.equal(fs.readFileSync(file, "utf8"), bytes);
		assert.equal(fs.existsSync(file + ".write.lock"), false);
	});
});

test("an unreadable legacy file prevents a lossy first migration", async (t) => {
	await isolated(({ file, legacy }) => {
		const bytes = JSON.stringify(ownValues(false));
		fs.writeFileSync(legacy, bytes);
		fs.chmodSync(legacy, 0o200);
		try {
			try { fs.readFileSync(legacy, "utf8"); return t.skip("file permissions do not restrict this user"); } catch (error) {
				assert.equal(error.code, "EACCES");
			}
			assert.throws(() => config.saveConfig({ [FIELDS[0]]: true }), (error) => error.code === "EACCES");
		} finally {
			fs.chmodSync(legacy, 0o600);
		}
		assert.equal(fs.readFileSync(legacy, "utf8"), bytes);
		assert.equal(fs.existsSync(file), false);
		assert.equal(fs.existsSync(file + ".write.lock"), false);
	});
});
