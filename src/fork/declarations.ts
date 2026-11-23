// pi keeps the tool list and system prompt in system messages, and its
// compaction drops them from the rebuilt history. The call that continues the
// turn then arrives with no system message, so the query Claude Code starts has
// no MCP server and no pi prompt: the model cannot call anything and ends the
// turn with no output. Reuse what the same pi session declared on its last
// call, under the updates that survived the compaction.
import { getCurrentSystemMessage, type Context, type Message, type SystemMessage, type Tool } from "@earendil-works/pi-ai";
import { debug } from "../debug.js";
import { toBridgeContext } from "../transcript.js";

// What each pi session last declared, replayed into one leading system message,
// and the system messages already folded into it, by content (pi rebuilds the
// message objects on every call, and two updates can share a millisecond). An
// empty declaration is kept too: it must not fall back to an older one.
interface Declared {
	head: SystemMessage;
	applied: Set<string>;
}
const lastDeclared = new Map<string, Declared>();
let activeToolNames: (() => string[]) | undefined;

// Where to ask pi for its current declaration for a session. Unset where the host
// cannot answer, and until the session's first event reaches the bridge.
type Snapshot = { systemPrompt: string | undefined; tools: Tool[] };
const snapshotSources = new Map<string, () => Snapshot | undefined>();

interface SnapshotPi {
	getActiveTools?(): string[];
	getAllTools?(): { name: string; description: string; parameters: unknown }[];
}
interface SnapshotCtx {
	sessionManager: { getSessionId(): string };
	getSystemPrompt?(): string;
}

/** Remember how to read pi's active tools and prompt for this session (hosts may lack any of these calls). */
export function setSnapshotSource(pi: SnapshotPi, ctx: SnapshotCtx): void {
	snapshotSources.set(ctx.sessionManager.getSessionId(), () => {
		if (!pi.getActiveTools || !pi.getAllTools) return undefined;
		try {
			const active = new Set(pi.getActiveTools());
			const tools = pi.getAllTools().filter((tool) => active.has(tool.name)) as unknown as Tool[];
			return { systemPrompt: ctx.getSystemPrompt?.(), tools };
		} catch (err) {
			debug(`provider: could not read pi's declaration: ${err instanceof Error ? err.message : String(err)}`);
			return undefined; // a context from a replaced session throws
		}
	});
}

/** pi's own view of the declared tools, for the warning below. */
export function setActiveToolsProbe(probe: (() => string[]) | undefined): void {
	activeToolNames = probe;
}

const systemMessages = (messages: readonly Message[]): SystemMessage[] => messages.filter((m): m is SystemMessage => m.role === "system");
const keyOf = (message: SystemMessage): string => JSON.stringify(message);

/**
 * `context` is in bridge shape (toBridgeContext); `source` is what pi passed.
 * pi's declaration is the system message at index 0; a system message anywhere
 * else is an update that survived the compaction. One the remembered state has
 * not folded in is replayed on it, once; one it has is
 * already reflected (or was undone by a later update the compaction dropped),
 * so replaying it again would repeat its prompt text or bring back a removed tool.
 */
export function withRememberedDeclarations(context: Context, source: Context, sessionId: string | undefined): Context {
	if (!sessionId) return context;
	const messages = source.messages;
	if (messages[0]?.role === "system") {
		lastDeclared.set(sessionId, {
			head: getCurrentSystemMessage(messages) ?? emptyDeclaration(),
			applied: new Set(systemMessages(messages).map(keyOf)),
		});
		return context;
	}
	const updates = systemMessages(messages);
	if (updates.length === 0 && (context.systemPrompt !== undefined || context.tools !== undefined)) {
		// Legacy shape: the fields themselves are the declaration, even when empty.
		const tools = context.tools ?? [];
		lastDeclared.set(sessionId, {
			head: { role: "system", content: context.systemPrompt ?? "", ...(tools.length > 0 ? { toolsAdded: tools } : {}), timestamp: 0 },
			applied: new Set(),
		});
		return context;
	}
	// pi's own state outranks what this module saw last: the session may have run on
	// another model since, with tools changed by updates the compaction dropped.
	const remembered = fromPi(sessionId, updates) ?? lastDeclared.get(sessionId);
	if (!remembered) return context;
	const fresh = updates.filter((message) => !remembered.applied.has(keyOf(message)));
	const head = getCurrentSystemMessage([remembered.head, ...fresh]) ?? remembered.head;
	lastDeclared.set(sessionId, { head, applied: new Set([...remembered.applied, ...fresh.map(keyOf)]) });
	const restored = toBridgeContext({ ...source, messages: [head, ...messages.filter((message) => message.role !== "system")] });
	debug(`provider: call carried no declaration; restored ${restored.tools?.length ?? 0} tools and the prompt from the session's last call, ${fresh.length} of ${updates.length} retained updates new`);
	return restored;
}

/** pi's current state already includes the retained updates, so they count as applied. */
function fromPi(sessionId: string, updates: SystemMessage[]): Declared | undefined {
	const snapshot = snapshotSources.get(sessionId)?.();
	if (!snapshot) return undefined;
	debug(`provider: call carried no declaration; read ${snapshot.tools.length} tools from pi`);
	const head: SystemMessage = {
		role: "system",
		content: snapshot.systemPrompt ?? "",
		...(snapshot.tools.length > 0 ? { toolsAdded: snapshot.tools } : {}),
		timestamp: 0,
	};
	return { head, applied: new Set(updates.map(keyOf)) };
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
