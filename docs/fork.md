# Fork inventory

Fork: `ricardofelixb/pi-claude-bridge`; upstream: `elidickinson/pi-claude-bridge`
(remote `upstream`). Fork code belongs in `src/fork/`; tests use `unit-fork-*.mjs`
so upstream's `test:unit` glob runs them too. Do not install this worktree in pi.

## 1. Continue at a tool result: upstream-owned since `ca1fbfc`

- Kind: generally useful bug fix (#274). Upstream `ca1fbfc` fixed it its own way: it
  writes the prompt into the transcript and lets the bundled Claude Code resume it.
  That replaced the fork's resume-prompt env, sync-row override, 30s stdin fallback
  and output tracking (fork PR #6, `0e9ff15`); their fork tests went with them.
- The fork keeps two changes on top, in `src/fork/continuation.ts` (re-exported by
  `src/fork/index.ts`), both upstream candidates:
  - Continuation note wording (fork PR #9): `CONTINUE_AFTER_REWRITE_PROMPT` and
    `CONTINUE_AFTER_RESUME_PROMPT` tell Claude the turn goes on and to make its next
    tool call or give the final answer. Upstream's two constants are deleted from
    `src/index.ts`; L23 imports the fork's, used unchanged at L1944.
  - `--await-initialize` before an automatic resume (fork PR #9): the SDK skips its
    initialize gate with a custom spawner, so the first resumed request could miss
    pi's MCP tools. Hook: L2012 `configureResumeArgs(extraArgs, Boolean(inlinePromptUuid));`.
- Keep pi's tools when compaction drops the system message (fork PR #8):
  `src/fork/declarations.ts`. Hooks in `src/index.ts`: L23 import,
  L1775 `withRememberedDeclarations`, L1908 `warnIfToolless`, L2276
  `setActiveToolsProbe`, L2310/L2341 `setSnapshotSource`, L2337–L2339 the
  `context_with_system` handler calling `observeDeclaration`.
- Setting: none. Tests: `tests/unit-orphan-result-after-restart.mjs` (note wording
  after restart and after compaction), `tests/unit-fork-declarations.mjs`,
  `tests/unit-rebuild-keeps-tools.mjs`, and the `--await-initialize` contract in
  `tests/int-cc-contracts.mjs` (inline prompt, delayed SDK handshake, first resumed
  request has the MCP tools). `diag/probe-haiku-continuation.mjs` compares the old
  note with the two fork notes live; `--no-tools` models an empty tool snapshot.

## 2. Per-project Claude account

- Kind: generally useful opt-in feature; upstream candidate after #274.
- Implementation: `src/fork/config.ts`, `src/fork/account.ts` (`applyAccount`).
- Hooks: `src/config.ts:11` imports `withProjectAccount, type AccountProvider`;
  `src/config.ts:17` intersects `Config.provider` with `AccountProvider`;
  `src/config.ts:57` accepts `loadConfig(cwd = process.cwd())`;
  `src/config.ts:67` returns
  `withProjectAccount({ askClaude: global.askClaude, provider }, cwd, tryParseJson)`
  after upstream's `systemPromptPreset` normalization.
  `src/index.ts:23` imports the shared fork barrel and `src/index.ts:2275`
  calls `registerAccount(pi, providerSettings)`.
- Setting: `provider.account`, global or project `.pi/claude-bridge.json`;
  project account overrides global account, no other project provider settings
  are trusted. Unset keeps the original Claude Code login. Missing named login
  fails closed instead of falling back to a different subscription.
- Fork tests: `tests/unit-fork-config.mjs`, `tests/unit-fork-account.mjs`.

## 3. /claude-account

- Kind: generally useful opt-in command; upstream candidate with account config.
- Implementation: `src/fork/account.ts`: switch/default, sign in via link and
  pasted code, confirm before creating a login, confirm sign out, reload.
- Hook: same `src/index.ts` import and `registerAccount(pi, providerSettings)`
  registration as account activation; no inline account policy remains there.
- Setting: writes only project `provider.account`; local git exclude protects
  the choice. Never changes executable or billing settings from project config.
- Fork test: `tests/unit-fork-account.mjs`; existing command-registration stubs
  in upstream test harnesses remain necessary.

## 4. Shortened history (#77): upstream-owned implementation

- Kind: regression originally fixed by fork; replaced by upstream digest sync
  (`b151768`, `10e61df`). No duplicate fork implementation or production hook.
- Setting: none; edited/shortened pi history is imported into a fresh transcript.
- Fork regression: "imports a compressed history instead of starting with none"
  in `tests/unit-fork-session-sync.mjs` (moved from fork commit `d63fcbb`).
- Upstream candidate: none; already upstream. Keep the fork regression.

## 5. CI on branch pushes

- Kind: fork infrastructure preference, already isolated in
  `.github/workflows/fork-ci.yml`; upstream `ci.yml` is untouched.
- Hook: none. Trigger: `push`, excluding `main`, plus `workflow_dispatch`.
- Setting: workflow triggers only; runs `npm ci` and `npm run test:unit`.
- Test: run those exact commands locally; no Claude credentials/calls needed.
- Upstream candidate: no (fork's GitHub event behavior).

## 6. Unreleased fork changelog

- Kind: fork release metadata. `CHANGELOG.md` keeps an `UNRELEASED` section for
  account and fork maintenance notes above upstream's released sections.
- Hook / setting: none. Test: inspect the header after each release merge.
- Upstream candidate: account feature note only if that feature is accepted.

## 7. Cut at Claude Code's own answer — upstream candidate (#272)

- Kind: generally useful bug fix; upstream issue #272. It edits upstream
  files and adds no `src/fork/` hook. When upstream fixes #272, take its fix
  and delete this entry.
- Bug: the model calls a pi tool and an unqualified `bash` in one message, Claude
  Code answers `bash` itself, and its answer, not pi's result, is what the chain
  continues from. A history rewrite (ACP `compress`) then cut at pi's result,
  which is off the primary chain, and `resolveCut` threw, failing the turn.
- Implementation: `onChainResult` in `src/session-transcript.ts` moves an
  off-chain tool-result boundary to the same group's on-chain result;
  `resolveRecordingCut` still rejects a cut that includes a later pi result.
  `src/index.ts` `syncSharedSession` (L639–L649) rebuilds from pi's history,
  with a debug line, when rows 6/7 cannot read or resolve the prefix.
- Setting: none. Tests: `tests/unit-session-prefix.mjs` (real-shaped fixture
  with a native-request check, the later-pi-result guard, the rebuild fallback).

## Quick checks and sync procedure

- `npm ci`
- Scoped unit checks: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-fork-*.mjs`
  and the relevant `tests/unit-*.mjs` suites for changed modules.
- CI unit command: `npm run test:unit`. Do **not** run `npm test` here: it also
  runs paid Claude live/integration tests. No known flaky unit tests.
- Typecheck: `npm run typecheck` (CI/conductor whole-project gate); implementer
  checks stay scoped per job instructions.
- Fetch both remotes and confirm origin/main is included before restructuring;
  this sync starts at `0e9ff15` (includes PR #6), not `1a08061`.
- Commit extractions before `git merge --no-ff upstream/main`. Keep upstream
  code in conflicts and reattach these hooks; rerere is enabled. Walk every
  entry's hook, setting and regression test after merging.
- Post-merge audit at upstream `28c4125` (0.13.1): entries 1–7 keep their hooks,
  settings and tests. Upstream's #292 `session_start` change (`piUI` only from a
  context with a UI) conflicted with the `setSnapshotSource` hook; both are kept.
  Upstream's #275 rate-limit headers and #294 streamed tool arguments touch no fork
  code; #272 is still unfixed upstream. Fork changelog entries stay under `UNRELEASED`.
- Post-merge audit at upstream `ca1fbfc`: entry 1's #274 fix is now upstream's;
  entries 2–7 and the fork's continuation note, `--await-initialize` and
  declaration hooks are in place. Upstream's inline-prompt resume, alternate
  executable stdin path and reserved-marker handling are kept unchanged.
- Post-merge audit at upstream `5ea9bb8`: all six entries above retain their
  hooks, settings and tests; #77 remains upstream-owned. Upstream's whole-prompt
  forwarding, preset normalization, rejected-tool-call handling and Mythos model
  changes are retained. Neither fork module depends on deleted
  `src/prompt-capture.ts` or `src/agents-md.ts`.
- Deleted fork test `tests/unit-prompt-capture-turn-failure.mjs` imported
  `__capture` from `src/prompt-capture.ts`. Its capture-failure path no longer
  exists in 0.13.0, so the test was retired with the module, not reimplemented.
  `tests/unit-system-prompt-provider.mjs` covers the new forwarding behavior;
  `tests/unit-cc-rejected-tool-call.mjs` retains rejection/failure coverage.
