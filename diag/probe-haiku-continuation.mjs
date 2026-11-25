#!/usr/bin/env node
// Compare Haiku's behavior at an interrupted tool result with the old rewrite
// note and the two current bridge notes. Uses live Claude Code and paid calls:
// node --import tsx diag/probe-haiku-continuation.mjs [runs-per-note] [old|rewrite|resume] [--no-tools]
// --no-tools models the original session's empty tool snapshot, before the
// separate fix that preserves the bridge's declarations on a rewrite.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSession, deleteSession } from "cc-session-io";
import { prepareContinuationPrompt, continuationChildEnv, continuationPromptEnv } from "../src/fork/continuation.ts";

const model = "claude-haiku-5-5";
const oldNote = "[Your context was compacted. What precedes this is a summary plus the most recent messages, "
	+ "ending with the tool result you were waiting for. Continue the task from there.]";
const runs = Number(process.argv[2] ?? "6");
const noTools = process.argv.includes("--no-tools");
const mode = process.argv.slice(3).find((arg) => arg !== "--no-tools");
const arms = mode ? [mode] : ["old", "rewrite", "resume"];
assert.ok(Number.isSafeInteger(runs) && runs > 0, "expected a positive trials-per-note count");
assert.ok(arms.every((arm) => ["old", "rewrite", "resume"].includes(arm)), "unknown note");
const cwd = mkdtempSync(join(tmpdir(), "haiku-continuation-"));
const claudeDir = process.env.CLAUDE_CONFIG_DIR;

async function trial(arm) {
	const session = createSession({ projectPath: cwd, claudeDir, model });
	session.importMessages([
		{ role: "user", content: "Read-only: check where imported records are saved and where follow-up work is registered." },
		{ role: "assistant", content: "The import saves invoices and payments directly. Follow-up work is registered separately in `core/functions.ts`." },
		{ role: "user", content: "You are the explorer: a quick assistant to the conductor. Work read-only. Every fact needs evidence, either a file:line or the command and output that shows it. Answer with the complete report, not a plan or recommendations.\n\nTask: inventory every piece of follow-up work after an import saves invoices and payments. For each one, show the function and what it reads and writes, whether it still runs in deferred mode and what it is computed per. Pull the evidence from the handler and its callees rather than guessing. Explain what still conflicts when multiple batches run in parallel." },
		{ role: "assistant", content: [{ type: "tool_use", id: "toolu_probe_search", name: "mcp__custom-tools__web_search", input: { query: "transaction concurrency limits" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_probe_search", content: "Official docs explain optimistic concurrency control but don't document the reported limit. An unverified forum report describes contention on the same key." }] },
		{ role: "assistant", content: [{ type: "tool_use", id: "toolu_probe_compact", name: "mcp__custom-tools__compress", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_probe_compact", content: "▣ ACP | 64.6K → 32.3K tokens (~32.4K reclaimed, blocks: b6=m00286–m00369)\n · b6 summary 19865ch · head \"TASK AS OF THIS BLOCK (open, current)\" … tail \"Open objectives: explorer report, this task, current.\"" }] },
	]);
	session.save();
	const { continuation } = prepareContinuationPrompt([{ role: "toolResult" }], arm !== "resume", arm === "resume", () => null, () => null);
	if (arm === "old") continuation.prompt = oldNote;
	let reads = 0;
	const server = new McpServer({ name: "custom-tools", version: "1.0.0" }, { capabilities: { tools: {} } });
	const tools = [
		["web_search", "Search documentation.", { query: { type: "string" } }],
		["compress", "Compact consumed context.", {}],
		["bash", "Execute a shell command in the sample repository and return its output.", { command: { type: "string" } }],
	].map(([name, description, properties]) => ({ name, description, inputSchema: { type: "object", properties } }));
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
	server.server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
		// Never execute the model's command; the fixture serves a canned result.
		if (params.name === "bash") reads++;
		return { content: [{ type: "text", text: params.name === "bash"
			? "core/functions.ts:8: onInvoiceSaved(recomputeInvoiceTotals);\ncore/functions.ts:9: onPaymentSaved(refreshAccountBalance);"
			: "No further results." }] };
	});
	let finishInput;
	const done = new Promise((resolve) => { finishInput = resolve; });
	// Like the bridge, leave stdin open without sending another user message.
	async function* input() { await done; }
	const abortController = new AbortController();
	const timeout = setTimeout(() => abortController.abort(), 60_000);
	let result;
	let text = "";
	let q;
	try {
		q = query({ prompt: input(), options: {
			cwd, resume: session.sessionId, model, abortController, effort: "low",
			systemPrompt: "You are a coding assistant running inside a harness. Help the user inspect files and run commands. Be concise in your responses.",
			env: continuationChildEnv(continuationPromptEnv(undefined, continuation), continuation),
			tools: [], mcpServers: noTools ? {} : { "custom-tools": { type: "sdk", name: "custom-tools", instance: server } },
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true, maxTurns: 1, settingSources: [],
			extraArgs: { "strict-mcp-config": null },
		} });
		for await (const message of q) {
			if (message.type === "assistant") {
				assert.equal(message.message.model, model, "unexpected model");
				for (const block of message.message.content) if (block.type === "text") text += block.text;
			}
			if (message.type === "result") { result = message; break; }
		}
		if (reads) {
			assert.equal(result?.subtype, "error_max_turns", "probe should stop after the first tool round");
			assert.equal(result.stop_reason, "tool_use");
		} else {
			assert.ok(result?.subtype === "success" && !result.is_error, `not a clean stop: ${JSON.stringify(result)}`);
			assert.equal(result.stop_reason, "end_turn");
		}
		const records = readFileSync(session.jsonlPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.ok(records.some((r) => r.type === "user" && r.isMeta && r.message?.content?.some((block) => block.type === "text" && block.text === continuation.prompt)),
			"CC did not inject the intended note as an interrupted-turn resume");
		const stopped = reads === 0;
		const spoke = text.trim().length > 0;
		console.log(`${arm}: ${stopped ? "stopped" : "continued"} (${JSON.stringify(text).slice(0, 200)})`);
		return { stopped, spoke };
	} finally {
		clearTimeout(timeout);
		finishInput();
		q?.close();
		deleteSession(session.sessionId, cwd, claudeDir);
	}
}

const counts = Object.fromEntries(arms.map((arm) => [arm, { stopped: 0, spoke: 0 }]));
try {
	for (let i = 0; i < runs; i++) {
		for (const arm of arms) {
			const { stopped, spoke } = await trial(arm);
			counts[arm].stopped += Number(stopped);
			counts[arm].spoke += Number(spoke);
		}
	}
	for (const arm of arms) {
		const { stopped, spoke } = counts[arm];
		console.log(`${arm}: ${runs - stopped}/${runs} continued; ${stopped}/${runs} stopped; ${spoke}/${runs} emitted text in the first response`);
	}
} finally {
	rmSync(cwd, { recursive: true, force: true });
}
