/**
 * Prompt cache: pi-cc-compaction changes only the compaction it is asked for.
 * Caching matches on the prefix (tools, then the system prompt, then the
 * messages), so an ordinary request must reach the provider exactly as Pi
 * and the other extensions built it.
 *
 * - No handler for an event that shapes a request (before_agent_start,
 *   context, context_with_system, tool_result, message_end), and no API that
 *   adds to the conversation or the tools. before_provider_request has a
 *   handler only so Pi routes requests through the runner; it returns nothing.
 * - The request capture wraps ExtensionRunner.emitBeforeProviderRequest and
 *   hands back the very object the handlers produced.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-compaction-cache-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_CC_CONFIG_FILE = path.join(agentDir, "pi-cc.json");

const { fakePi, loadModule } = await import("./helpers.mjs");

const SHAPING_EVENTS = ["before_agent_start", "context", "context_with_system", "tool_result", "message_end", "input"];

test("index.ts: no handler that shapes a request, and no API that adds to it", async () => {
	const mod = await loadModule("index.ts");
	const host = fakePi();
	mod.default(host.pi);
	for (const event of SHAPING_EVENTS) assert.ok(!host.handlers.has(event), `${event} handler`);
	assert.deepEqual(host.calls, [], "no sendMessage, sendUserMessage, setActiveTools or registerTool");
	// before_provider_request is listened to only so Pi routes requests through the
	// runner (where they are captured); the handler passes the payload on untouched.
	const payload = { model: "m", messages: [{ role: "user", content: "hi" }], tools: [] };
	const snapshot = structuredClone(payload);
	assert.deepEqual(await host.emit("before_provider_request", { payload }), [undefined]);
	assert.deepEqual(payload, snapshot);
	// turn_end could add entries or another model request; the handler returns nothing.
	const ctx = { sessionManager: { getSessionId: () => "cache-s" }, model: { id: "m" } };
	assert.deepEqual(await host.emit("turn_end", { message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, ctx), [undefined]);
});

test("the capture passes the request through untouched", async () => {
	const patches = await loadModule("patches.ts");
	const produced = { model: "m", messages: [{ role: "user", content: "hi" }] };
	class Runner {
		sessionManager = { getSessionId: () => "cache-s", getLeafId: () => "l" };
		async emitBeforeProviderRequest() {
			return produced;
		}
	}
	patches.installPatches({ SettingsManager: undefined, ExtensionRunner: Runner });
	const sent = await new Runner().emitBeforeProviderRequest({});
	assert.equal(sent, produced, "the same object, not a copy");
	assert.deepEqual(produced, { model: "m", messages: [{ role: "user", content: "hi" }] }, "and not modified");
});
