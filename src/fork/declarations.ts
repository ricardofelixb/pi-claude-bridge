// pi keeps the tool list and system prompt in system messages, and its
// compaction drops them from the rebuilt history. The call that continues the
// turn then arrives with no system message, so the query Claude Code starts has
// no MCP server and no pi prompt: the model cannot call anything and ends the
// turn with no output. Reuse what the same pi session declared on its last
// call, under the updates that survived the compaction.
import { getCurrentSystemMessage, type Context, type SystemMessage } from "@earendil-works/pi-ai";
import { debug } from "../debug.js";
import { toBridgeContext } from "../transcript.js";

// What each pi session last declared, replayed into one leading system message.
// An empty declaration is kept too: it must not fall back to an older one.
const lastDeclared = new Map<string, SystemMessage>();
let activeToolNames: (() => string[]) | undefined;

/** pi's own view of the declared tools, for the warning below. */
export function setActiveToolsProbe(probe: (() => string[]) | undefined): void {
	activeToolNames = probe;
}

/**
 * `context` is in bridge shape (toBridgeContext); `source` is what pi passed.
 * pi's declaration is the system message at index 0; a system message anywhere
 * else is an update that survived the compaction, to replay on the remembered one.
 */
export function withRememberedDeclarations(context: Context, source: Context, sessionId: string | undefined): Context {
	if (!sessionId) return context;
	const messages = source.messages;
	if (messages[0]?.role === "system") {
		lastDeclared.set(sessionId, getCurrentSystemMessage(messages) ?? emptyDeclaration());
		return context;
	}
	const hasUpdates = messages.some((message) => message.role === "system");
	if (!hasUpdates && (context.systemPrompt !== undefined || context.tools !== undefined)) {
		// Legacy shape: the fields themselves are the declaration, even when empty.
		const tools = context.tools ?? [];
		lastDeclared.set(sessionId, {
			role: "system",
			content: context.systemPrompt ?? "",
			...(tools.length > 0 ? { toolsAdded: tools } : {}),
			timestamp: 0,
		});
		return context;
	}
	const remembered = lastDeclared.get(sessionId);
	if (!remembered) return context;
	const restored = toBridgeContext({ ...source, messages: [remembered, ...messages] });
	lastDeclared.set(sessionId, getCurrentSystemMessage([remembered, ...messages]) ?? remembered);
	debug(`provider: call carried no declaration; restored ${restored.tools?.length ?? 0} tools and the prompt from the session's last call${hasUpdates ? " plus its retained updates" : ""}`);
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
