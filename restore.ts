/**
 * Restore recent file context without performing another filesystem read.
 *
 * Only completed, successful file calls count. Direct reads can replay the
 * text present in both the answered request and the projected conversation;
 * writes, edits and nested calls carry a reference instead. Historical
 * permission grants never authorize fresh reads during compaction.
 *
 * Keep up to five paths, newest first, excluding calls kept verbatim. Cached
 * excerpts are capped at 5K tokens each and 50K total (characters / 4).
 */

import path from "node:path";

const FILE_TOOLS = new Set(["read", "edit", "write"]);

export const MAX_RESTORED_FILES = 5;
export const FILE_TOKEN_CAP = 5000;
export const RESTORE_TOKEN_BUDGET = 50000;

interface ToolCallBlock {
	type?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

interface NestedCall {
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	status?: string;
	error?: string;
}

interface MessageLike {
	role?: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	content?: unknown;
	nestedCalls?: { calls?: NestedCall[] };
}

interface FileCall {
	path: string;
	id?: string;
	ownerId?: string;
	name?: string;
	input?: Record<string, unknown>;
	succeeded: boolean;
	content?: string;
}

function filePath(name: string | undefined, args: Record<string, unknown> | undefined, cwd: string): string | undefined {
	if (!FILE_TOOLS.has(name ?? "")) return undefined;
	const target = args?.path;
	return typeof target === "string" && target !== "" ? path.resolve(cwd, target) : undefined;
}

function textOf(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
	return text.trim() && !text.includes("\u0000") ? text : undefined;
}

function payloadText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() && !content.includes("\u0000") ? content : undefined;
	if (!Array.isArray(content)) return undefined;
	return textOf(content
		.filter((block) => ["text", "input_text", "output_text"].includes(block?.type))
		.map((block) => ({ type: "text", text: block.text })));
}

/** Tool-result text in the last answered provider request, after all request-side filtering. */
export function capturedToolResults(api: string, payload: unknown): ReadonlyMap<string, string> {
	const results = new Map<string, string>();
	if (!payload || typeof payload !== "object") return results;
	const body = payload as Record<string, unknown>;
	const add = (id: unknown, content: unknown) => {
		const text = payloadText(content);
		if (typeof id === "string" && id && text !== undefined) results.set(id, text);
	};
	if (api === "anthropic-messages" && Array.isArray(body.messages)) {
		for (const message of body.messages) {
			if (message?.role !== "user" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type === "tool_result" && block.is_error !== true) add(block.tool_use_id, block.content);
			}
		}
	} else if (api === "openai-completions" && Array.isArray(body.messages)) {
		for (const message of body.messages) {
			if (message?.role === "tool") add(message.tool_call_id, message.content);
		}
	} else if (api === "openai-responses" && Array.isArray(body.input)) {
		for (const item of body.input) {
			if (item?.type === "function_call_output") add(item.call_id, item.output);
		}
	}
	return results;
}

/** Pair calls with results; missing, conflicting or failed results stay ineligible. */
function fileCallsOf(messages: readonly MessageLike[], cwd: string, readCache?: ReadonlyMap<string, string>): FileCall[] {
	const files: FileCall[] = [];
	const calls = new Map<string, FileCall>();
	const seenIds = new Set<string>();
	const ambiguousIds = new Set<string>();
	const completedIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as ToolCallBlock[]) {
				if (block?.type !== "toolCall") continue;
				const file = filePath(block.name, block.arguments, cwd);
				if (typeof block.id !== "string" || !block.id) {
					if (file) files.push({ path: file, succeeded: false });
					continue;
				}
				if (seenIds.has(block.id)) {
					ambiguousIds.add(block.id);
					const previous = calls.get(block.id);
					if (previous) previous.succeeded = false;
				}
				seenIds.add(block.id);
				if (!file) continue;
				const call: FileCall = { path: file, id: block.id, name: block.name, input: block.arguments, succeeded: false };
				calls.set(block.id, call);
				files.push(call);
			}
		}
		if (message.role !== "toolResult") continue;
		const id = message.toolCallId;
		const call = typeof id === "string" ? calls.get(id) : undefined;
		if (call && id) {
			if (completedIds.has(id) || ambiguousIds.has(id)) {
				call.succeeded = false;
			} else {
				completedIds.add(id);
				call.succeeded = message.isError === false && message.toolName === call.name;
				const sent = readCache?.get(id);
				if (call.succeeded && call.name === "read" && sent !== undefined) {
					const projected = textOf(message.content);
					// Respect both request-side redaction/truncation and later context
					// edits. Never replay raw text that was not sent, or a sent version
					// no longer present in the current projection.
					if (projected) {
						if (sent.includes(projected)) call.content = projected;
						else if (projected.includes(sent)) call.content = sent;
					}
				}
			}
		}
		// Pi records status and arguments, never the nested result. Do not
		// reconstruct that result by reading the path ourselves.
		for (const nested of message.nestedCalls?.calls ?? []) {
			const file = filePath(nested.name, nested.arguments, cwd);
			if (!file) continue;
			files.push({
				path: file,
				id: nested.id,
				ownerId: id,
				succeeded: message.isError === false && nested.status === "ok" && nested.error === undefined,
			});
		}
	}
	return files;
}

function callIdsOf(messages: readonly MessageLike[]): Set<string> {
	const ids = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && typeof message.toolCallId === "string") ids.add(message.toolCallId);
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as ToolCallBlock[]) {
			if (block?.type === "toolCall" && typeof block.id === "string") ids.add(block.id);
		}
	}
	return ids;
}

/** A later failed or unconfirmed attempt also fences off an earlier successful read. */
export function recentFiles(messages: readonly MessageLike[], kept: readonly MessageLike[], cwd: string): string[] {
	const keptIds = callIdsOf(kept);
	const seen = new Set<string>();
	const picked: string[] = [];
	for (const call of fileCallsOf(messages, cwd).reverse()) {
		if (seen.has(call.path)) continue;
		seen.add(call.path);
		if (!call.succeeded || (call.id && keptIds.has(call.id)) || (call.ownerId && keptIds.has(call.ownerId))) continue;
		picked.push(call.path);
		if (picked.length >= MAX_RESTORED_FILES) break;
	}
	return picked;
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function reference(file: string): string {
	return `Previously accessed file: ${JSON.stringify(file)}. Its contents were not re-read during compaction; use the read tool if needed (normal permission checks apply).`;
}

function cachedRead(file: string, call: FileCall): string {
	// Keep only Pi read arguments, not private fields another hook may have
	// attached to the call after the model produced it.
	const input: Record<string, unknown> = { path: file };
	for (const key of ["offset", "limit"]) {
		const value = call.input?.[key];
		if (typeof value === "number" && Number.isFinite(value)) input[key] = value;
	}
	return `Cached output from a successful read before compaction (historical excerpt; the file may have changed):\nCalled the read tool with the following input: ${JSON.stringify(input)}\n\nResult of calling the read tool:\n${call.content}`;
}

/** Only replay already-returned text; never bypass tool hooks with filesystem I/O. */
export function restoreBlocks(
	files: readonly string[],
	options: { totalTokens?: number; fileTokens?: number; messages?: readonly MessageLike[]; cwd?: string; readCache?: ReadonlyMap<string, string> } = {},
): string[] {
	const total = options.totalTokens ?? RESTORE_TOKEN_BUDGET;
	const cap = options.fileTokens ?? FILE_TOKEN_CAP;
	const cwd = options.cwd ?? process.cwd();
	const latest = new Map(fileCallsOf(options.messages ?? [], cwd, options.readCache).map((call) => [call.path, call]));
	const blocks: string[] = [];
	let used = 0;
	for (const target of files) {
		const file = path.resolve(cwd, target);
		const call = latest.get(file);
		if (call && !call.succeeded) continue;
		let block = call?.content === undefined ? reference(file) : cachedRead(file, call);
		if (estimateTokens(block) > cap) {
			block = `Note: ${JSON.stringify(file)} was accessed before the last conversation was summarized, but the cached contents are too large to include. Use the read tool if needed (normal permission checks apply).`;
		}
		const tokens = estimateTokens(block);
		if (tokens > cap || used + tokens > total) continue;
		used += tokens;
		blocks.push(block);
	}
	return blocks;
}
