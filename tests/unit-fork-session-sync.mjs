import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openSession } from "cc-session-io";
import { stateFor } from "./lib/session-state.mjs";
import { digestMessages } from "../src/message-digests.js";

const { __test } = await import("../src/index.js");
const user = (content) => ({ role: "user", content, timestamp: 1 });
const assistant = (content) => ({ role: "assistant", content, provider: "claude-bridge", timestamp: 1 });
const say = (text) => assistant([{ type: "text", text }]);
let cwd, oldClaudeDir;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "fork-session-sync-"));
	oldClaudeDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = join(cwd, "cc");
	__test.resetSharedSession();
});
afterEach(() => {
	__test.resetSharedSession();
	if (oldClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = oldClaudeDir;
	rmSync(cwd, { recursive: true, force: true });
});
const sync = (messages) => __test.syncSharedSession(messages, cwd, new Map(), "sonnet", "pi", undefined, "");
function seed(messages) {
	const session = createSession({ projectPath: cwd, model: "sonnet" });
	const state = stateFor(session, messages, "sonnet");
	session.save();
	__test.setSharedSession("pi", state);
	return { session, state };
}

describe("fork history regressions", () => {
	// Context folding fires no rewrite event; import the shortened history (#77).
	it("imports a compressed history instead of starting with none", () => {
		seed([user("a"), say("b"), user("c"), say("d"), user("e"), say("f")]);
		const compressed = [user("[summary] earlier work"), say("Noted.")];
		const synced = sync([...compressed, user("next")]);
		assert.ok(synced.sessionId);
		assert.deepEqual(synced.recorded.digests, digestMessages(compressed));
		assert.equal(openSession({ sessionId: synced.sessionId, projectPath: cwd }).messages.length, 2);
	});
});
