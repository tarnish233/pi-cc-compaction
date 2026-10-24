import assert from "node:assert";
import test from "node:test";
import { loadModule } from "./helpers.mjs";

const prompt = await loadModule("prompt.ts");

test("the summary request is Claude Code's control arm, framed as text-only", () => {
	const text = prompt.summaryRequest();
	assert.ok(text.startsWith("CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n"));
	// Pi's tool names, lowercase, where Claude Code lists its own.
	assert.ok(text.includes("- Do NOT use read, bash, edit, write, grep, find, ls, or ANY other tool.\n"));
	assert.ok(text.includes("- Your entire response must be plain text: an <analysis> block followed by a <summary> block.\n"));
	assert.ok(text.includes("Your task is to create a detailed summary of the conversation so far, paying close attention"));
	for (const section of [
		"1. Primary Request and Intent:",
		"2. Key Technical Concepts:",
		"3. Files and Code Sections:",
		"4. Errors and fixes:",
		"5. Problem Solving:",
		"6. All user messages:",
		"7. Pending Tasks:",
		"8. Current Work:",
		"9. Optional Next Step:",
	]) {
		assert.ok(text.includes(section), section);
	}
	assert.ok(text.includes("Before providing your final summary, wrap your analysis in <analysis> tags"));
	assert.ok(
		text.endsWith(
			"\n\nREMINDER: Do NOT call any tools. Respond with plain text only \u2014 an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.",
		),
	);
	assert.ok(!text.includes("Additional Instructions:"));
});

test("custom /compact instructions go in as Additional Instructions, before the reminder", () => {
	const text = prompt.summaryRequest("  keep the failing test names  ");
	const at = text.indexOf("\n\nAdditional Instructions:\n  keep the failing test names  ");
	assert.ok(at > 0, "instructions appended verbatim");
	assert.ok(at < text.indexOf("\n\nREMINDER:"), "before the reminder");
	assert.equal(prompt.summaryRequest("   "), prompt.summaryRequest(), "blank instructions are ignored");
});

test("formatSummary drops the analysis and labels the summary, as Claude Code does", () => {
	const reply = "<analysis>\nthinking it over\n</analysis>\n\n<summary>\n1. Primary Request:\n   do it\n\n\n\n2. More\n</summary>\n";
	assert.equal(prompt.formatSummary(reply), "Summary:\n1. Primary Request:\n   do it\n\n2. More");
	assert.equal(prompt.hasSummaryBlock(reply), true);
	// A reply cut off by the output cap is still used; it just keeps its text.
	const cut = "<analysis>\nstill going";
	assert.equal(prompt.formatSummary(cut), "<analysis>\nstill going");
	assert.equal(prompt.hasSummaryBlock(cut), false);
});

test("the summary message carries Claude Code's continuation text", () => {
	const text = prompt.summaryMessage({
		reply: "<summary>S</summary>",
		toolNames: ["bash", "read"],
		transcriptPath: "/tmp/session.jsonl",
		keptMessages: true,
	});
	assert.ok(
		text.startsWith(
			"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n<tools-used-before-summary>bash, read</tools-used-before-summary>\nSummary:\nS",
		),
	);
	assert.ok(
		text.includes(
			"\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /tmp/session.jsonl",
		),
	);
	assert.ok(text.includes("\nContinue the conversation from where it left off without asking the user any further questions."));
	assert.ok(text.includes("Pick up the last task as if the break never happened."));
	assert.ok(
		text.endsWith(
			"The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them.",
		),
	);
	const bare = prompt.summaryMessage({ reply: "<summary>S</summary>", keptMessages: false });
	assert.ok(bare.includes("<tools-used-before-summary></tools-used-before-summary>\n"));
	assert.ok(!bare.includes("read the full transcript"));
	assert.ok(!bare.includes("kept verbatim"));
});

test("restored files follow the summary", () => {
	const text = prompt.summaryMessage({ reply: "<summary>S</summary>", keptMessages: false, restored: ["FILE-A", "FILE-B"] });
	assert.ok(text.endsWith("\n\nFILE-A\n\nFILE-B"));
});
