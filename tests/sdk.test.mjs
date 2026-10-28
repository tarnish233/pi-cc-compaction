import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { extensionDir, findPiInstall, loadModule } from "./helpers.mjs";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-sdk-parallel-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CC_CONFIG_FILE = path.join(agentDir, "pi-cc.json");
const install = findPiInstall();
const { createAgentSession, DefaultResourceLoader, SessionManager } = await import(pathToFileURL(install.piCodingAgent).href);

async function session(name) {
	const cwd = path.join(agentDir, name);
	fs.mkdirSync(cwd);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [path.join(extensionDir, "index.ts")],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, resourceLoader, sessionManager: SessionManager.inMemory(), noTools: true });
	await session.bindExtensions({ mode: "rpc" });
	return session;
}

test("disposing an SDK session removes it from the process-wide compaction setting decision", async () => {
	let a, b;
	try {
		a = await session("a");
		b = await session("b");
		const rt = globalThis[Symbol.for("pi-cc-compaction:runtime")];
		assert.equal(rt.activeSessions.size, 2);
		assert.equal(rt.override, undefined, "Pi's compaction is safer while two sessions coexist");
		const id = a.sessionManager.getSessionId();
		const breaker = await loadModule("breaker.ts");
		for (let i = 0; i < 3; i++) breaker.noteFailure(id);
		rt.captures.set(id, { payload: {}, leafId: null, at: Date.now() });
		a.dispose();
		a = undefined;
		assert.equal(rt.activeSessions.size, 1, "dispose invalidates the runner but does not emit session_shutdown");
		assert.equal(rt.captures.has(id), false, "the disposed session leaves no request behind");
		assert.equal(breaker.isOpen(id), false, "its breaker is cleared too");
		assert.equal(typeof rt.override, "function", "the remaining session can use its own settings");
		b.dispose();
		b = undefined;
		assert.equal(rt.activeSessions.size, 0);
		assert.equal(rt.override, undefined);
	} finally {
		a?.dispose();
		b?.dispose();
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
