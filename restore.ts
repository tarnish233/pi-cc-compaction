/**
 * What Claude Code puts back after a compaction: the files read most recently.
 *
 * Claude Code re-reads up to five of the files it read or wrote most recently
 * (newest first), skipping files whose read is already among the messages it
 * keeps verbatim. A file is capped at 5K tokens and the set at 50K; a file
 * over the cap is replaced by a note to read it again. They are attached as a
 * Read call and its result. Pi has no attachment slot after a compaction, so
 * the blocks follow the summary text instead, in the same wording.
 *
 * Tokens are estimated at four characters each, as Pi and Claude Code do.
 */

import fs from "node:fs";
import path from "node:path";

/** Pi's built-in tools that leave a file's content in the conversation. */
const FILE_TOOLS = new Set(["read", "edit", "write"]);

export const MAX_RESTORED_FILES = 5;
export const FILE_TOKEN_CAP = 5000;
export const RESTORE_TOKEN_BUDGET = 50000;

interface ToolCallBlock {
	type?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface MessageLike {
	role?: string;
	content?: unknown;
}

function filePathsOf(messages: readonly MessageLike[], cwd: string): string[] {
	const paths: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as ToolCallBlock[]) {
			if (block?.type !== "toolCall" || !FILE_TOOLS.has(block.name ?? "")) continue;
			const target = block.arguments?.path;
			if (typeof target === "string" && target !== "") paths.push(path.resolve(cwd, target));
		}
	}
	return paths;
}

function isRegularFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * The files to restore, absolute and newest first: those the conversation
 * read, edited or wrote, minus the ones a kept message already reads, that
 * still exist as regular files.
 */
export function recentFiles(messages: readonly MessageLike[], kept: readonly MessageLike[], cwd: string): string[] {
	const inKept = new Set(filePathsOf(kept, cwd));
	const newestFirst = filePathsOf(messages, cwd).reverse();
	const picked: string[] = [];
	for (const file of newestFirst) {
		if (picked.length >= MAX_RESTORED_FILES) break;
		if (picked.includes(file) || inKept.has(file) || !isRegularFile(file)) continue;
		picked.push(file);
	}
	return picked;
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function tooLargeNote(file: string): string {
	return `Note: ${file} was read before the last conversation was summarized, but the contents are too large to include. Use read tool if you need to access it.`;
}

function readCall(file: string, content: string): string {
	return `Called the read tool with the following input: ${JSON.stringify({ path: file })}\n\nResult of calling the read tool:\n${content}`;
}

/** The blocks to append after the summary, within the token budget. */
export function restoreBlocks(files: readonly string[], options: { totalTokens?: number; fileTokens?: number } = {}): string[] {
	const total = options.totalTokens ?? RESTORE_TOKEN_BUDGET;
	const cap = options.fileTokens ?? FILE_TOKEN_CAP;
	const blocks: string[] = [];
	let used = 0;
	for (const file of files) {
		let content: string;
		try {
			content = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (content.includes("\u0000")) continue;
		const block = estimateTokens(content) > cap ? tooLargeNote(file) : readCall(file, content);
		const tokens = estimateTokens(block);
		if (used + tokens > total) continue;
		used += tokens;
		blocks.push(block);
	}
	return blocks;
}
