/**
 * A fresh query that follows a compaction still gets pi's tools and prompt.
 *
 * pi keeps the tool list and the system prompt in system messages, and its
 * compaction drops them from the rebuilt history. A call that continues the
 * turn after that arrives with no system message, no `tools` and no prompt, so
 * the rebuilt Claude Code query started with no MCP server at all: the model
 * could not call anything, planned its next step in thinking and ended the turn
 * with no output. Seen in Claude Code's own request snapshots (`tools: []` on
 * every rebuild that failed to act, 21 tools on every one that did).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts, markRebuildForSession } = mod.__test;
let providerConfig;
const handlers = {};
let activeNow = ["read", "bash"];
const piTools = () => [
	{ name: "read", description: "Read a file", parameters: schema },
	{ name: "bash", description: "Run a command", parameters: schema },
	{ name: "grep", description: "Search", parameters: schema },
];
mod.default({
	on: (name, fn) => { (handlers[name] ??= []).push(fn); },
	getActiveTools: () => activeNow,
	getAllTools: piTools,
	registerProvider: (_name, config) => { providerConfig = config; },
	registerCommand: () => {},
});
const { streamSimple } = providerConfig;
const model = providerConfig.models[0];

const tools = [
	{ name: "read", description: "Read a file", parameters: schema },
	{ name: "bash", description: "Run a command", parameters: schema },
];
const PROMPT = "You are the pi test prompt.";
let clock = 0;
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: clock++ });
const head = (toolsAdded = tools) => ({ role: "system", content: PROMPT, toolsAdded, timestamp: 0 });
const call = (id) => ({
	role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
	api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", usage: {}, timestamp: clock++,
});
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });

let launches;
beforeEach(() => {
	activeNow = ["read", "bash"];
	resetSharedSession();
	activeQueryContexts.clear();
	launches = [];
	setQuery(({ options }) => {
		launches.push(options);
		const gen = (async function* () {
			// A tool-result continuation resumes without a prompt, so none is awaited.
			yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume };
			yield { type: "assistant", parent_tool_use_id: null, uuid: `u${launches.length}`, session_id: "s", message: { id: `msg_${launches.length}`, model: model.id, content: [{ type: "text", text: "ok" }] } };
			yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId ?? options.resume };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});
afterEach(() => setQuery(null));

/** The tool names Claude Code would list from the query's MCP server. */
async function servedTools(options) {
	const server = options.mcpServers?.["custom-tools"];
	if (!server) return [];
	const list = server.instance.server._requestHandlers.get("tools/list");
	return (await list({ method: "tools/list", params: {} }, {})).tools.map((t) => t.name);
}
const run = (context, sessionId) => streamSimple(model, context, { sessionId, signal: new AbortController().signal }).result();

describe("fresh query after a compaction", () => {
	it("serves the tools and prompt of the session's earlier requests", async () => {
		const ask = user("do the thing");
		const first = await run({ messages: [head(), ask] }, "pi-rebuilt");
		assert.equal(first.stopReason, "stop", first.errorMessage);
		assert.deepEqual(await servedTools(launches[0]), ["read", "bash"], "control: the first query has the tools");

		// pi compacted: the history is a summary plus the kept tail, with no system message.
		markRebuildForSession("pi-rebuilt", "session_compact:threshold");
		const tail = [user("[summary of earlier work]"), call("toolu_1"), toolResult("toolu_1")];
		const rebuilt = await run({ messages: tail }, "pi-rebuilt");
		assert.equal(rebuilt.stopReason, "stop", rebuilt.errorMessage);

		assert.equal(launches.length, 2);
		assert.deepEqual(await servedTools(launches[1]), ["read", "bash"], "the rebuilt query serves the same tools");
		assert.equal(launches[1].systemPrompt.append, PROMPT, "and pi's prompt");
	});

	it("takes the tools a call declares over the remembered ones", async () => {
		await run({ messages: [head(), user("one")] }, "pi-changed");
		await run({ messages: [head([tools[0]]), user("one"), call("toolu_1"), toolResult("toolu_1"), user("two")] }, "pi-changed");
		assert.deepEqual(await servedTools(launches[1]), ["read"]);
	});

	it("does not borrow another session's tools", async () => {
		await run({ messages: [head(), user("one")] }, "pi-owner");
		await run({ messages: [user("[summary]"), call("toolu_1"), toolResult("toolu_1")] }, "pi-stranger");
		assert.deepEqual(await servedTools(launches[1]), [], "a session that never declared tools stays without");
	});

	it("applies a tool removal that survived the compaction to the remembered tools", async () => {
		await run({ messages: [head(), user("one")] }, "pi-removed");
		const removal = { role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 5 };
		await run({ messages: [user("[summary]"), removal, call("toolu_1"), toolResult("toolu_1")] }, "pi-removed");
		assert.deepEqual(await servedTools(launches[1]), ["read"], "bash stays removed, read stays");
	});

	it("applies a prompt section update that survived the compaction", async () => {
		await run({ messages: [{ ...head(), sections: { rules: "<rules>old</rules>" } }, user("one")] }, "pi-section");
		const update = { role: "system", content: "", sections: { rules: "<rules>new</rules>" }, timestamp: 5 };
		await run({ messages: [user("[summary]"), update, call("toolu_1"), toolResult("toolu_1")] }, "pi-section");
		const prompt = launches[1].systemPrompt.append;
		assert.match(prompt, /<rules>new<\/rules>/);
		assert.doesNotMatch(prompt, /<rules>old/);
		assert.deepEqual(await servedTools(launches[1]), ["read", "bash"]);
	});

	it("does not restore tools after the session declared none", async () => {
		await run({ messages: [head(), user("one")] }, "pi-emptied");
		await run({ messages: [{ role: "system", content: "", timestamp: 0 }, user("one"), call("toolu_1"), toolResult("toolu_1")] }, "pi-emptied");
		await run({ messages: [user("[summary]"), call("toolu_2"), toolResult("toolu_2")] }, "pi-emptied");
		assert.deepEqual(await servedTools(launches[2]), [], "an empty system declaration is a declaration");

		await run({ messages: [head(), user("one")] }, "pi-legacy");
		await run({ messages: [user("two")], tools: [] }, "pi-legacy");
		await run({ messages: [user("[summary]"), call("toolu_3"), toolResult("toolu_3")] }, "pi-legacy");
		assert.deepEqual(await servedTools(launches[5]), [], "so is an explicit empty tool list");
	});

	it("does not bring back a tool whose removal the compaction dropped", async () => {
		const added = { role: "system", content: "", toolsAdded: [tools[1]], timestamp: 5 };
		const removed = { role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 6 };
		await run({ messages: [head([tools[0]]), added, user("one"), removed, user("two")] }, "pi-undone");
		// the compaction kept the earlier addition and dropped the removal that undid it
		await run({ messages: [user("[summary]"), added, call("toolu_1"), toolResult("toolu_1")] }, "pi-undone");
		assert.deepEqual(await servedTools(launches[1]), ["read"]);
	});

	it("adds a retained update's prompt text once, however many calls carry it", async () => {
		await run({ messages: [head(), user("one")] }, "pi-once");
		const rule = { role: "system", content: "RULE", timestamp: 5 };
		for (const id of ["toolu_1", "toolu_2", "toolu_3"]) {
			await run({ messages: [user("[summary]"), rule, call(id), toolResult(id)] }, "pi-once");
		}
		for (const launch of launches.slice(1)) {
			assert.equal(launch.systemPrompt.append, `${PROMPT}\n\nRULE`);
		}
		assert.ok(launches.length > 1);
	});

	it("tells updates apart that share a timestamp", async () => {
		const added = { role: "system", content: "", toolsAdded: [tools[1]], timestamp: 5 };
		const removed = { role: "system", content: "", toolsRemoved: [{ name: "bash" }], timestamp: 5 };
		// both updates already seen, the compaction keeps only the removal: it stays applied
		await run({ messages: [head([tools[0]]), added, removed, user("one")] }, "pi-same-ms");
		await run({ messages: [user("[summary]"), removed, call("toolu_1"), toolResult("toolu_1")] }, "pi-same-ms");
		assert.deepEqual(await servedTools(launches[1]), ["read"]);
		// the removal first arrives after the compaction, in the same millisecond as the addition
		await run({ messages: [head([tools[0]]), added, user("one")] }, "pi-same-ms-new");
		await run({ messages: [user("[summary]"), added, removed, call("toolu_2"), toolResult("toolu_2")] }, "pi-same-ms-new");
		assert.deepEqual(await servedTools(launches[3]), ["read"]);
	});

	it("reads pi's own tools and prompt when the bridge has seen none for the session", async () => {
		// pi switched to this provider (or the bridge reloaded) after a compaction
		const ctx = { sessionManager: { getSessionId: () => "pi-cold" }, getSystemPrompt: () => PROMPT };
		for (const fn of handlers.agent_start) fn({}, ctx);
		const retained = { role: "system", content: "", toolsRemoved: [{ name: "read" }], timestamp: 5 };
		await run({ messages: [user("[summary]"), call("toolu_1"), toolResult("toolu_1")] }, "pi-cold");
		assert.deepEqual(await servedTools(launches[0]), ["read", "bash"], "only the tools pi has active");
		assert.equal(launches[0].systemPrompt.append, PROMPT);

		for (const fn of handlers.agent_start) fn({}, { ...ctx, sessionManager: { getSessionId: () => "pi-cold2" } });
		await run({ messages: [user("[summary]"), retained, call("toolu_2"), toolResult("toolu_2")] }, "pi-cold2");
		assert.deepEqual(await servedTools(launches[1]), ["read", "bash"], "pi's state already includes a retained update");
	});

	it("takes pi's current tools over the remembered ones when the session ran elsewhere in between", async () => {
		const ctx = { sessionManager: { getSessionId: () => "pi-switched" }, getSystemPrompt: () => PROMPT };
		for (const fn of handlers.agent_start) fn({}, ctx);
		await run({ messages: [head(), user("one")] }, "pi-switched");
		assert.deepEqual(await servedTools(launches[0]), ["read", "bash"]);
		// another model's turns disabled bash, and the compaction dropped that update
		activeNow = ["read"];
		for (const fn of handlers.agent_start) fn({}, ctx);
		await run({ messages: [user("[summary]"), call("toolu_1"), toolResult("toolu_1")] }, "pi-switched");
		assert.deepEqual(await servedTools(launches[1]), ["read"]);
	});

	it("keeps the prompt the session declared when pi's own prompt lacks an extension's change", async () => {
		const ctx = { sessionManager: { getSessionId: () => "pi-ext-prompt" }, getSystemPrompt: () => "BASE" };
		for (const fn of handlers.agent_start) fn({}, ctx);
		// an extension added RULE to the request's system message; pi's getter does not see it
		await run({ messages: [{ ...head(), content: "BASE\n\nRULE" }, user("one")] }, "pi-ext-prompt");
		await run({ messages: [user("[summary]"), call("toolu_1"), toolResult("toolu_1")] }, "pi-ext-prompt");
		assert.equal(launches[1].systemPrompt.append, "BASE\n\nRULE");
		assert.deepEqual(await servedTools(launches[1]), ["read", "bash"]);
	});

	it("restores the prompt a session last sent to another model", async () => {
		const ctx = { sessionManager: { getSessionId: () => "pi-elsewhere" }, getSystemPrompt: () => "BASE" };
		await run({ messages: [{ ...head(), content: "BASE\n\nOLD RULE" }, user("one")] }, "pi-elsewhere");
		// a turn on another model, with the rule changed; the compaction then drops that update
		for (const fn of handlers.context_with_system) fn({ messages: [{ ...head(), content: "BASE\n\nNEW RULE" }, user("two")] }, ctx);
		await run({ messages: [user("[summary]"), call("toolu_1"), toolResult("toolu_1")] }, "pi-elsewhere");
		assert.equal(launches[1].systemPrompt.append, "BASE\n\nNEW RULE");
	});
});
