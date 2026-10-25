import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const restore = await loadModule("restore.ts");

const call = (name, args) => ({ role: "assistant", content: [{ type: "toolCall", id: `${name}-${JSON.stringify(args)}`, name, arguments: args }] });

function workspace(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-compaction-restore-"));
	for (const [name, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), body);
	}
	return dir;
}

test("the files read or written most recently, newest first, minus those the kept messages hold", () => {
	const dir = workspace({ "a.ts": "A", "b.ts": "B", "c.ts": "C", "d.ts": "D", "e.ts": "E" });
	const summarized = [
		call("read", { path: "a.ts" }),
		call("edit", { path: "b.ts", oldText: "x", newText: "y" }),
		call("read", { path: "c.ts" }),
		call("write", { path: path.join(dir, "d.ts"), content: "D" }),
		call("bash", { command: "cat e.ts" }),
		call("read", { path: "a.ts" }),
		call("read", { path: "missing.ts" }),
	];
	const kept = [call("read", { path: "c.ts" })];
	assert.deepEqual(restore.recentFiles([...summarized, ...kept], kept, dir), [path.join(dir, "a.ts"), path.join(dir, "d.ts"), path.join(dir, "b.ts")]);
});

test("at most five, and only regular text files", () => {
	const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}.txt`, `${i}`]));
	const dir = workspace({ ...files, "bin.dat": "a\u0000b" });
	fs.mkdirSync(path.join(dir, "folder"));
	const messages = [call("read", { path: "folder" }), call("read", { path: "bin.dat" }), ...Object.keys(files).map((name) => call("read", { path: name }))];
	const picked = restore.recentFiles(messages, [], dir);
	assert.deepEqual(picked, ["f6.txt", "f5.txt", "f4.txt", "f3.txt", "f2.txt"].map((name) => path.join(dir, name)));
	assert.equal(restore.restoreBlocks([path.join(dir, "bin.dat")]).length, 0, "binary content is not restored");
});

test("restored files are written as Claude Code writes them: the read call and its result", () => {
	const dir = workspace({ "a.ts": "export const a = 1;\n" });
	const [block] = restore.restoreBlocks([path.join(dir, "a.ts")]);
	assert.equal(
		block,
		`Called the read tool with the following input: ${JSON.stringify({ path: path.join(dir, "a.ts") })}\n\nResult of calling the read tool:\nexport const a = 1;\n`,
	);
});

test("a file over 5K tokens gets Claude Code's note instead; the total stays within 50K", () => {
	const dir = workspace({ "big.ts": "x".repeat(20001 * 1), "a.ts": "a".repeat(16000), "b.ts": "b".repeat(16000), "c.ts": "c".repeat(16000), "d.ts": "d".repeat(16000) });
	const blocks = restore.restoreBlocks(["big.ts", "a.ts", "b.ts", "c.ts", "d.ts"].map((name) => path.join(dir, name)));
	assert.equal(
		blocks[0],
		`Note: ${path.join(dir, "big.ts")} was read before the last conversation was summarized, but the contents are too large to include. Use read tool if you need to access it.`,
	);
	// 4,000 tokens each: three fit in what 50K leaves after the note, the fourth would not.
	const small = restore.restoreBlocks(["a.ts", "b.ts", "c.ts", "d.ts"].map((name) => path.join(dir, name)), { totalTokens: 12500 });
	assert.equal(small.length, 3);
	assert.equal(restore.restoreBlocks(["a.ts", "b.ts", "c.ts", "d.ts"].map((name) => path.join(dir, name))).length, 4);
});

test("a file a codemode script read counts too: its calls are recorded on the tool result", () => {
	const dir = workspace({ "script.ts": "S", "from-call.ts": "C", "kept.ts": "K" });
	// One script call read two files; a later one read a third. A tool result
	// carries the calls the tool made (name, arguments), as Pi records them.
	const script = (...calls) => ({
		role: "toolResult",
		content: [{ type: "text", text: "Script completed" }],
		nestedCalls: { calls: calls.map((path) => ({ id: `t/${path}`, name: "read", arguments: { path }, status: "ok" })), complete: true },
	});
	const summarized = [call("bash", { command: "true" }), script("script.ts", "from-call.ts")];
	const kept = [script("kept.ts")];
	assert.deepEqual(restore.recentFiles([...summarized, ...kept], kept, dir), [path.join(dir, "from-call.ts"), path.join(dir, "script.ts")]);
});

test("a script's file args that were dropped for size, or a tool that is not a file tool, are skipped", () => {
	const dir = workspace({ "a.ts": "A", "b.ts": "B" });
	const messages = [
		{
			role: "toolResult",
			content: [],
			nestedCalls: {
				calls: [
					{ id: "t/1", name: "read", arguments: { path: "a.ts" }, status: "ok" },
					{ id: "t/2", name: "read", argumentsBytes: 9000, status: "ok" },
					{ id: "t/3", name: "grep", arguments: { path: "b.ts" }, status: "ok" },
					{ id: "t/4", name: "edit", arguments: { path: "b.ts" }, status: "ok" },
				],
				complete: false,
			},
		},
	];
	assert.deepEqual(restore.recentFiles(messages, [], dir), [path.join(dir, "b.ts"), path.join(dir, "a.ts")]);
});
