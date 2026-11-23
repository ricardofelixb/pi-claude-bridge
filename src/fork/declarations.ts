// pi keeps the tool list and system prompt in system messages, and its
// compaction drops them from the rebuilt history. The call that continues the
// turn then arrives with no system message, so the query Claude Code starts has
// no MCP server and no pi prompt: the model cannot call anything and ends the
// turn with no output. Reuse what the same pi session declared on its last
// call, under the updates that survived the compaction.
import { getCurrentSystemMessage, type Context, type SystemMessage } from "@earendil-works/pi-ai";
import { debug } from "../debug.js";
import { toBridgeContext } from "../transcript.js";

// What each pi session last declared, replayed into one leading system message,
// and the timestamp of the newest system message already folded into it. An
// empty declaration is kept too: it must not fall back to an older one.
interface Declared {
	head: SystemMessage;
	appliedThrough: number;
}
const lastDeclared = new Map<string, Declared>();
let activeToolNames: (() => string[]) | undefined;

/** pi's own view of the declared tools, for the warning below. */
export function setActiveToolsProbe(probe: (() => string[]) | undefined): void {
	activeToolNames = probe;
}

const newestSystemTimestamp = (messages: readonly { role: string; timestamp?: number }[]): number =>
	Math.max(-Infinity, ...messages.filter((message) => message.role === "system").map((message) => message.timestamp ?? 0));

/**
 * `context` is in bridge shape (toBridgeContext); `source` is what pi passed.
 * pi's declaration is the system message at index 0; a system message anywhere
 * else is an update that survived the compaction. An update newer than what the
 * remembered state has folded in is replayed on it, once; an older one is
 * already reflected (or was undone by a later update the compaction dropped),
 * so replaying it again would repeat its prompt text or bring back a removed tool.
 */
export function withRememberedDeclarations(context: Context, source: Context, sessionId: string | undefined): Context {
	if (!sessionId) return context;
	const messages = source.messages;
	if (messages[0]?.role === "system") {
		lastDeclared.set(sessionId, {
			head: getCurrentSystemMessage(messages) ?? emptyDeclaration(),
			appliedThrough: newestSystemTimestamp(messages),
		});
		return context;
	}
	const updates = messages.filter((message) => message.role === "system");
	if (updates.length === 0 && (context.systemPrompt !== undefined || context.tools !== undefined)) {
		// Legacy shape: the fields themselves are the declaration, even when empty.
		const tools = context.tools ?? [];
		lastDeclared.set(sessionId, {
			head: { role: "system", content: context.systemPrompt ?? "", ...(tools.length > 0 ? { toolsAdded: tools } : {}), timestamp: 0 },
			appliedThrough: -Infinity,
		});
		return context;
	}
	const remembered = lastDeclared.get(sessionId);
	if (!remembered) return context;
	const fresh = updates.filter((message) => message.timestamp > remembered.appliedThrough);
	const head = getCurrentSystemMessage([remembered.head, ...fresh]) ?? remembered.head;
	lastDeclared.set(sessionId, { head, appliedThrough: Math.max(remembered.appliedThrough, newestSystemTimestamp(fresh)) });
	const restored = toBridgeContext({ ...source, messages: [head, ...messages.filter((message) => message.role !== "system")] });
	debug(`provider: call carried no declaration; restored ${restored.tools?.length ?? 0} tools and the prompt from the session's last call, ${fresh.length} of ${updates.length} retained updates new`);
	return restored;
}

function emptyDeclaration(): SystemMessage {
	return { role: "system", content: "", timestamp: 0 };
}

/** A query without tools while pi has some is the failure above; say so in the log. */
export function warnIfToolless(toolCount: number, sessionTag: string): void {
	if (toolCount > 0) return;
	const active = activeToolNames?.().length ?? 0;
	if (active > 0) debug(`provider: query starts with no tools but pi has ${active} active ${sessionTag}`);
}
