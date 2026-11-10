// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json).
// and the project Pi config directory, which only names a login for the project:
// `provider`, which is global only apart from `provider.account`. Missing or
// unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts. A cloned repo could otherwise point
// the bridge at its own Claude Code executable or turn on metered billing.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Config {
	/** Removed: AskClaude is its own package. Read only to warn whoever still has it enabled. */
	askClaude?: { enabled?: boolean };
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Named Claude Code login for this project: runs Claude Code with
		// CLAUDE_CONFIG_DIR=~/.claude-accounts/<account>, so one repo can bill
		// another subscription. Unset uses Claude Code's own default login.
		account?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context;
		// newer models get 1M on every plan.
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// Model ids (e.g. "claude-future-9") whose declared 1M context Claude Code
		// does not actually serve; pins them to the bare id at 200K.
		forceTwoHundredK?: string[];
	};
}

function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

/** The Claude Code config directory holding a named account's login. Throws on a
 *  name that could escape ~/.claude-accounts, so a typo never picks another login. */
export function accountConfigDir(account: string): string {
	if (!/^[\w-][\w.-]*$/.test(account)) {
		throw new Error(`claude-bridge: provider.account ${JSON.stringify(account)} must be a plain name like "banx"`);
	}
	return join(homedir(), ".claude-accounts", account);
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	return {
		askClaude: global.askClaude,
		// Global only: a cloned repo could otherwise point the bridge at its own
		// Claude Code executable or turn on metered billing. The exception is
		// `account`, a plain name for a login already under ~/.claude-accounts, which
		// is how a project picks its account (see account.ts).
		provider: { ...global.provider, ...(project.provider?.account !== undefined ? { account: project.provider.account } : {}) },
	};
}
