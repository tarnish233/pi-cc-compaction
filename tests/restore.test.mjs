import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const restore = await loadModule("restore.ts");
const CWD = path.resolve(os.tmpdir(), "virtual-compaction-history");
let serial = 0;
const call = (name, args, id = `call-${++serial}`) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
const result = (request, text = "", isError = false) => ({
	role: "toolResult", toolCallId: request.content[0].id, toolName: request.content[0].name,
	isError, content: [{ type: "text", text }],
});
const completed = (name, args, text = "", isError = false) => {
	const request = call(name, args);
	return [request, result(request, text, isError)];
};
// Model-visible tool outputs for these isolated fixtures; individual tests
// override the captured request to exercise request-side filtering.
const options = (messages, cwd = CWD, extra = {}) => ({
	messages, cwd,
	readCache: restore.capturedToolResults("openai-completions", { messages: messages.filter((m) => m.role === "toolResult" && m.isError === false).map((m) => ({ role: "tool", tool_call_id: m.toolCallId, content: m.content })) }),
	...extra,
});
const file = (name) => path.resolve(CWD, name);

function workspace(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-compaction-restore-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Any restoration-time filesystem inspection of this fixture is a failure. */
function withoutFileIO(dir, fn) {
	const originals = new Map();
	const touched = [];
	for (const name of ["readFileSync", "statSync", "lstatSync", "realpathSync", "openSync"]) {
		const original = fs[name];
		originals.set(name, original);
		fs[name] = (target, ...args) => {
			if (typeof target === "string" && (target === dir || target.startsWith(`${dir}${path.sep}`))) {
				touched.push([name, target]);
				throw new Error("compaction must not access the fixture filesystem");
			}
			return original(target, ...args);
		};
	}
	try {
		fn();
		assert.deepEqual(touched, [], "no permission-bypassing filesystem operation");
	} finally {
		for (const [name, original] of originals) fs[name] = original;
	}
}

test("only confirmed successful calls, newest first, excluding kept calls", () => {
	const summarized = [
		...completed("read", { path: "a.ts" }, "A"),
		...completed("edit", { path: "b.ts", oldText: "x", newText: "y" }, "Edited"),
		...completed("read", { path: "c.ts" }, "C"),
		...completed("write", { path: file("d.ts"), content: "D" }, "Written"),
		...completed("bash", { command: "true" }, ""),
		...completed("read", { path: "a.ts" }, "A2"),
		...completed("read", { path: "missing.ts" }, "File not found", true),
	];
	const kept = completed("read", { path: "c.ts" }, "C2");
	assert.deepEqual(restore.recentFiles([...summarized, ...kept], kept, CWD), [file("a.ts"), file("d.ts"), file("b.ts")]);
});

test("at most five confirmed paths; no current filesystem state is needed", () => {
	const messages = Array.from({ length: 7 }, (_, i) => completed("read", { path: `f${i}.txt` }, `${i}`)).flat();
	assert.deepEqual(restore.recentFiles(messages, [], CWD), [6, 5, 4, 3, 2].map((i) => file(`f${i}.txt`)));
});

test("restore the exact returned excerpt and read arguments, explicitly marked as cached", () => {
	const messages = completed("read", { path: "a.ts", offset: 10, limit: 2 }, "visible excerpt\n");
	const [block] = restore.restoreBlocks([file("a.ts")], options(messages));
	assert.equal(block,
		`Cached output from a successful read before compaction (historical excerpt; the file may have changed):\nCalled the read tool with the following input: ${JSON.stringify({ path: file("a.ts"), offset: 10, limit: 2 })}\n\nResult of calling the read tool:\nvisible excerpt\n`);
});

test("restoration does not replay private extra arguments attached by a hook", () => {
	const messages = completed("read", { path: "a.ts", offset: 10, limit: 2, privateToken: "HOOK_PRIVATE_FIXTURE" }, "PUBLIC");
	const [block] = restore.restoreBlocks([file("a.ts")], options(messages));
	assert.match(block, /PUBLIC/);
	assert.doesNotMatch(block, /HOOK_PRIVATE_FIXTURE|privateToken/);
	assert.ok(block.includes(JSON.stringify({ path: file("a.ts"), offset: 10, limit: 2 })));
});

test("oversized cached output is a note; file and total budgets include the wrapper", () => {
	const names = ["big.ts", "a.ts", "b.ts", "c.ts", "d.ts"];
	const messages = names.flatMap((name) => completed("read", { path: name }, name === "big.ts" ? "x".repeat(20001) : "a".repeat(16000)));
	const blocks = restore.restoreBlocks(names.map(file), options(messages));
	assert.match(blocks[0], /cached contents are too large to include/);
	assert.ok(blocks.every((text) => Math.ceil(text.length / 4) <= restore.FILE_TOKEN_CAP));
	assert.ok(blocks.reduce((n, text) => n + Math.ceil(text.length / 4), 0) <= restore.RESTORE_TOKEN_BUDGET);
	assert.equal(restore.restoreBlocks(names.slice(1).map(file), options(messages, CWD, { totalTokens: 12500 })).length, 3);
	assert.equal(restore.restoreBlocks(names.slice(1).map(file), options(messages)).length, 4);
	assert.deepEqual(restore.restoreBlocks(names.map(file), options(messages, CWD, { totalTokens: 0 })), []);
	assert.deepEqual(restore.restoreBlocks(names.map(file), options(messages, CWD, { fileTokens: 0 })), []);
});

test("a refused read is not selected or restored even when the file is OS-readable", (t) => {
	const dir = workspace(t), target = path.join(dir, "denied.txt");
	fs.writeFileSync(target, "UNAPPROVED_FIXTURE_ONLY");
	const messages = completed("read", { path: target }, "Permission denied by tool_call policy", true);
	withoutFileIO(dir, () => {
		assert.deepEqual(restore.recentFiles(messages, [], dir), []);
		assert.deepEqual(restore.restoreBlocks([target], options(messages, dir)), []);
	});
	assert.equal(fs.readFileSync(target, "utf8"), "UNAPPROVED_FIXTURE_ONLY");
});

test("a later refusal or unfinished read fences off an earlier approved excerpt", () => {
	const approved = completed("read", { path: "a.ts" }, "PREVIOUSLY_APPROVED");
	for (const later of [
		completed("read", { path: "a.ts" }, "Permission denied", true),
		[call("read", { path: "a.ts" })],
		[{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }] }],
	]) {
		const messages = [...approved, ...later];
		assert.deepEqual(restore.recentFiles(messages, [], CWD), []);
		assert.deepEqual(restore.restoreBlocks([file("a.ts")], options(messages)), []);
	}
});

test("new or deleted file contents are never fetched during restoration", (t) => {
	const dir = workspace(t), target = path.join(dir, "changed.txt");
	fs.writeFileSync(target, "NEW_UNOBSERVED_CONTENT");
	const messages = completed("read", { path: target, limit: 1 }, "OLD_RETURNED_EXCERPT");
	for (const deleted of [false, true]) {
		if (deleted) fs.unlinkSync(target);
		withoutFileIO(dir, () => {
			const [block] = restore.restoreBlocks(restore.recentFiles(messages, [], dir), options(messages, dir));
			assert.match(block, /OLD_RETURNED_EXCERPT/);
			assert.doesNotMatch(block, /NEW_UNOBSERVED_CONTENT/);
		});
	}
});

test("retargeting a symlink cannot introduce a new target's content", (t) => {
	const dir = workspace(t), link = path.join(dir, "public.txt");
	fs.writeFileSync(path.join(dir, "approved.txt"), "OLD_APPROVED");
	fs.writeFileSync(path.join(dir, "private.txt"), "NEW_PRIVATE_FIXTURE");
	fs.symlinkSync(path.join(dir, "approved.txt"), link);
	const messages = completed("read", { path: link }, "OLD_APPROVED");
	fs.unlinkSync(link);
	fs.symlinkSync(path.join(dir, "private.txt"), link);
	withoutFileIO(dir, () => {
		const [block] = restore.restoreBlocks(restore.recentFiles(messages, [], dir), options(messages, dir));
		assert.match(block, /OLD_APPROVED/);
		assert.doesNotMatch(block, /NEW_PRIVATE_FIXTURE/);
	});
});

test("only model-visible text is cached, not structuredContent or image data", () => {
	const messages = completed("read", { path: "a.ts" }, "[redacted by tool_result]");
	messages[1].structuredContent = { secret: "RAW_STRUCTURED_SECRET" };
	messages[1].content.push({ type: "image", data: "IMAGE_SECRET", mimeType: "image/png" });
	const [block] = restore.restoreBlocks([file("a.ts")], options(messages));
	assert.match(block, /redacted by tool_result/);
	assert.doesNotMatch(block, /RAW_STRUCTURED_SECRET|IMAGE_SECRET/);
});

test("writes, edits, empty/binary results and paths without cached output only get references", () => {
	for (const messages of [
		completed("write", { path: "a.ts", content: "NOT_A_READ_RESULT" }, "Written"),
		[...completed("read", { path: "a.ts" }, "OLD_EXCERPT"), ...completed("edit", { path: "a.ts" }, "Edited")],
		completed("read", { path: "a.ts" }, ""),
		completed("read", { path: "a.ts" }, "binary\u0000data"),
		[],
	]) {
		const [block] = restore.restoreBlocks([file("a.ts")], options(messages));
		assert.match(block, /Previously accessed file:.*normal permission checks apply/);
		assert.doesNotMatch(block, /NOT_A_READ_RESULT|OLD_EXCERPT|binary\u0000data|Result of calling/);
	}
});

function script(calls, isError = false) {
	const request = call("codemode", { code: "fixture" });
	const output = result(request, "Script completed", isError);
	output.nestedCalls = { calls: calls.map((c, i) => ({ id: `${request.content[0].id}/${i + 1}`, ...c })), complete: true };
	return [request, output];
}

test("successful nested calls count, but their missing results must not be reconstructed", () => {
	const summarized = script([{ name: "read", arguments: { path: "a.ts" }, status: "ok" }, { name: "write", arguments: { path: "b.ts" }, status: "ok" }]);
	const kept = script([{ name: "read", arguments: { path: "kept.ts" }, status: "ok" }]);
	const messages = [...summarized, ...kept];
	assert.deepEqual(restore.recentFiles(messages, kept, CWD), [file("b.ts"), file("a.ts")]);
	const blocks = restore.restoreBlocks([file("a.ts"), file("b.ts")], options(messages));
	assert.ok(blocks.every((text) => text.includes("Previously accessed file:")));
});

test("failed, unfinished, unrecorded and contradictory nested calls are ineligible", () => {
	const calls = [
		{ name: "read", arguments: { path: "error.ts" }, status: "error" },
		{ name: "read", arguments: { path: "unfinished.ts" }, status: "unfinished" },
		{ name: "read", arguments: { path: "unknown.ts" } },
		{ name: "read", arguments: { path: "contradictory.ts" }, status: "ok", error: "denied" },
		{ name: "read", argumentsBytes: 9000, status: "ok" },
		{ name: "grep", arguments: { path: "ignored.ts" }, status: "ok" },
	];
	assert.deepEqual(restore.recentFiles(script(calls), [], CWD), []);
	assert.deepEqual(restore.recentFiles(script([{ name: "read", arguments: { path: "a.ts" }, status: "ok" }], true), [], CWD), []);
	const denied = [...completed("read", { path: "a.ts" }, "OLD"), ...script([{ name: "read", arguments: { path: "a.ts" }, status: "error" }])];
	assert.deepEqual(restore.recentFiles(denied, [], CWD), []);
});

test("a kept result excludes its read even when the call is in the summarized prefix", () => {
	const messages = completed("read", { path: "a.ts" }, "already kept");
	assert.deepEqual(restore.recentFiles(messages, [messages[1]], CWD), []);
});

test("unpaired, mismatched, ambiguous or non-explicit success results are not trusted", () => {
	const request = call("read", { path: "a.ts" }, "same-id");
	const missingFlag = result(request, "UNKNOWN"); delete missingFlag.isError;
	for (const messages of [
		[request],
		[request, { ...result(request), toolCallId: "other-id" }],
		[request, { ...result(request), toolName: "bash" }],
		[request, missingFlag],
		[request, result(request), call("read", { path: "b.ts" }, "same-id"), result(request)],
		[request, result(request), result(request)],
		[{ role: "user", nestedCalls: { calls: [{ name: "read", arguments: { path: "a.ts" }, status: "ok" }] } }],
	]) assert.deepEqual(restore.recentFiles(messages, [], CWD), []);
});

test("captured results use only actual tool-output fields in all three provider APIs", () => {
	const captures = [
		["anthropic-messages", { system: "NOT_TOOL_TEXT", messages: [{ role: "user", content: [{ type: "text", text: "NOT_TOOL_TEXT" }, { type: "tool_result", tool_use_id: "read-id", content: [{ type: "text", text: "SENT" }, { type: "image", data: "NOT_TEXT" }], structuredContent: "NOT_TEXT" }, { type: "tool_result", tool_use_id: "failed", content: "DENIED", is_error: true }] }] }],
		["openai-completions", { messages: [{ role: "system", content: "NOT_TOOL_TEXT" }, { role: "tool", tool_call_id: "read-id", content: [{ type: "text", text: "SENT" }], structuredContent: "NOT_TEXT" }] }],
		["openai-responses", { instructions: "NOT_TOOL_TEXT", input: [{ type: "function_call", call_id: "other", arguments: "NOT_TEXT" }, { type: "function_call_output", call_id: "read-id", output: [{ type: "input_text", text: "SENT" }, { type: "image", data: "NOT_TEXT" }] }] }],
	];
	for (const [api, payload] of captures) assert.deepEqual([...restore.capturedToolResults(api, payload)], [["read-id", "SENT"]], api);
	assert.equal(restore.capturedToolResults("unsupported", captures[0][1]).size, 0);
	assert.equal(restore.capturedToolResults("openai-completions", null).size, 0);
});

test("successful raw history is not enough to replay text absent from the answered request", () => {
	const messages = completed("read", { path: "a.ts" }, "NEVER_SENT_RAW_SECRET");
	const id = messages[1].toolCallId;
	for (const opts of [
		{ messages, cwd: CWD },
		options(messages, CWD, { readCache: new Map() }),
		options(messages, CWD, { readCache: new Map([[id, "[redacted by provider request hook]"]]) }),
	]) {
		const [block] = restore.restoreBlocks([file("a.ts")], opts);
		assert.match(block, /Previously accessed file:/);
		assert.doesNotMatch(block, /NEVER_SENT_RAW_SECRET/);
	}
});

test("replay respects both request-side truncation and later projection redaction", () => {
	const messages = completed("read", { path: "a.ts" }, "PUBLIC\nPRIVATE");
	const id = messages[1].toolCallId;
	const [publicOnly] = restore.restoreBlocks([file("a.ts")], options(messages, CWD, { readCache: new Map([[id, "PUBLIC\n"]]) }));
	assert.match(publicOnly, /Cached output/);
	assert.match(publicOnly, /PUBLIC/);
	assert.doesNotMatch(publicOnly, /PRIVATE/);
	messages[1].content = [{ type: "text", text: "[redacted by context edit]" }];
	const [reference] = restore.restoreBlocks([file("a.ts")], options(messages, CWD, { readCache: new Map([[id, "PUBLIC\nPRIVATE"]]) }));
	assert.match(reference, /Previously accessed file:/);
	assert.doesNotMatch(reference, /PRIVATE/);
});

test("file references quote unusual paths rather than inserting their newlines as instructions", () => {
	const target = file("odd\nname.ts");
	const messages = completed("read", { path: target }, "x".repeat(20001));
	for (const blocks of [restore.restoreBlocks([target]), restore.restoreBlocks([target], options(messages))]) {
		assert.ok(blocks[0].includes(JSON.stringify(target)));
		assert.ok(!blocks[0].includes("\n"));
	}
});
