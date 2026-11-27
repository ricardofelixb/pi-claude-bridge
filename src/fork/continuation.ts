// Upstream resumes a turn that goes on at its tool result by writing the prompt
// into the transcript and letting Claude Code resume it (#274). The fork keeps
// two changes on top: a continuation note that says the turn goes on, and the
// SDK initialize gate before Claude Code's automatic resume.

const CONTINUE_SAME_TURN = "This is the same turn. Do not reply to this note. "
	+ "Use the tool result above and make your next tool call, or give your final answer if the task is done.";
/** A plain "continue" can draw a status-only reply that ends an unfinished turn. */
export const CONTINUE_AFTER_REWRITE_PROMPT = `[Your context was compacted. ${CONTINUE_SAME_TURN}]`;
export const CONTINUE_AFTER_RESUME_PROMPT = `[Your session was interrupted and resumed. ${CONTINUE_SAME_TURN}]`;

export function configureResumeArgs(args: Record<string, string | null>, resuming: boolean): void {
	// Auto-resume can send the first API request before SDK initialize brings
	// in pi's MCP manifest. The SDK normally gates resumes on initialize, but
	// it skips that gate when the bridge supplies its own process spawner.
	if (resuming) args["await-initialize"] = null;
}
