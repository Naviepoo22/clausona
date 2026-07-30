# Codex Token Usage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track new Codex CLI input and output tokens per Clausona profile without importing historical sessions or estimating dollar cost.

**Architecture:** Add an isolated reverse JSONL reader for Codex session totals, then extend the existing usage tracker with optional per-session cursors and positive-delta recording. Shell and explicit-run entry points identify the profile that supplied `CODEX_HOME`; existing list and usage views reuse the current `UsageRecord` summaries with zero cost for Codex.

**Tech Stack:** TypeScript 5.9, Node.js 20 filesystem APIs, Vitest 4, Ink CLI, Biome

## Global Constraints

- Track only activity that happens after a Codex profile establishes its baseline.
- Record exact `input_tokens` and `output_tokens`; do not estimate dollar cost.
- Treat Codex `input_tokens` as the displayed input total, including cached input.
- Do not add cached-input, cache-write-input, reasoning-output, quota, or rate-limit fields.
- Do not persist prompts, responses, working directories, or other session content.
- Keep `usage.json` backward compatible; no store-version migration or new dependency.
- Preserve Codex and Claude process exit codes and environment cleanup on POSIX and PowerShell.
- Keep existing Claude tracking behavior unchanged.

---

## File Structure

- Create `src/core/codex-usage.ts`: traverse Codex session directories and extract the latest valid cumulative counters from JSONL files.
- Create `src/core/codex-usage.test.ts`: parser and filesystem traversal fixtures.
- Create `src/core/track-usage.test.ts`: prospective baseline, positive-delta, reset, and profile-resolution tests.
- Modify `src/core/track-usage.ts`: dispatch by profile tool, seed Codex cursors, calculate deltas, and persist one record per pass.
- Modify `src/types.ts`: add `CodexSessionCursor` and the optional `codexSessions` usage-store field.
- Modify `src/lib/service.ts`: seed both Claude and Codex profiles during initialization and profile creation.
- Modify `src/lib/service.integration.test.ts`: assert Codex baseline creation does not import history.
- Modify `src/core/shell.ts`: invoke post-run tracking for Codex before restoring `CODEX_HOME`.
- Modify `src/core/shell.test.ts` and `src/core/shell.integration.test.ts`: verify tracking placement, exit status, and environment restoration.
- Modify `src/index.tsx` and `src/index.test.ts`: track explicit `clausona run` Codex profiles.
- Modify `src/commands.ts`: pass the internal tracking target and allow public Codex usage queries.
- Modify `src/lib/format.ts`: render Codex token counts and remove the unsupported footnote.
- Modify `src/tui/App.test.tsx` or `src/index.test.ts`: cover visible Codex token output at the existing presentation boundary.
- Modify `README.md`: document two-tool tracking and the Codex tokens-only limitation.

---

### Task 1: Codex Session Counter Reader

**Files:**
- Create: `src/core/codex-usage.ts`
- Create: `src/core/codex-usage.test.ts`

**Interfaces:**
- Produces: `CodexTokenTotals = { inputTokens: number; outputTokens: number }`
- Produces: `readLatestCodexTokenTotals(filePath: string): Promise<CodexTokenTotals | null>`
- Produces: `readCodexSessionTotals(configDir: string): Promise<Record<string, CodexTokenTotals>>`
- Cursor keys returned by `readCodexSessionTotals` are slash-normalized paths relative to `<configDir>/sessions`.

- [ ] **Step 1: Write failing parser tests**

Create fixtures in a temporary directory and assert:

```ts
expect(await readLatestCodexTokenTotals(file)).toEqual({
  inputTokens: 125,
  outputTokens: 17,
});
```

The fixture must include an earlier valid `token_count`, a later valid one, a
null `info` event, an unrelated event, and a malformed/incomplete final line.
Add separate tests that reject negative, non-finite, string, and missing
counters and return `null` when no valid event exists.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/core/codex-usage.test.ts
```

Expected: FAIL because `./codex-usage.js` and its exports do not exist.

- [ ] **Step 3: Implement bounded reverse JSONL parsing**

Use `open`, `stat`, and positional `read` from `node:fs/promises`. Start with a
64 KiB suffix, discard a partial first line when the read does not start at byte
zero, scan complete lines newest-first, and double the suffix until a valid
event is found or the complete file has been inspected. Accept only:

```ts
event.type === "event_msg";
event.payload?.type === "token_count";
Number.isFinite(event.payload.info?.total_token_usage?.input_tokens);
Number.isFinite(event.payload.info?.total_token_usage?.output_tokens);
inputTokens >= 0;
outputTokens >= 0;
```

Always close the file handle in `finally`. Catch per-file read/parse failures and
return `null`.

- [ ] **Step 4: Add recursive session discovery**

Walk `<configDir>/sessions` with `readdir(..., { withFileTypes: true })`, ignore
symlinks and non-JSONL files, and parse files independently. Convert
`path.relative(sessionRoot, file)` separators to `/`. Return `{}` for a missing
or unreadable sessions directory.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run src/core/codex-usage.test.ts
```

Expected: all parser and traversal tests PASS.

- [ ] **Step 6: Commit the parser slice**

```powershell
git add src/core/codex-usage.ts src/core/codex-usage.test.ts
git commit -m "feat: read codex session token totals"
```

---

### Task 2: Prospective Codex Cursors and Delta Tracking

**Files:**
- Modify: `src/types.ts`
- Modify: `src/core/track-usage.ts`
- Create: `src/core/track-usage.test.ts`

**Interfaces:**
- Consumes: `readCodexSessionTotals(configDir)`
- Produces: `CodexSessionCursor = { inputTokens: number; outputTokens: number }`
- Produces: `seedProfileUsage(profileId: string, tool: ToolName, configDir: string): Promise<void>`
- Keeps: `trackUsage(target?: string): Promise<void>`, where `target` is a qualified profile ID, `"claude"`, `"codex"`, or omitted.

- [ ] **Step 1: Write failing delta tests**

Mock `readCodexSessionTotals` and Clausona storage paths, then cover these exact
state transitions:

```ts
undefined
// first pass -> codexSessions is populated, records stays []

{ "2026/07/30/a.jsonl": { inputTokens: 100, outputTokens: 10 } }
// next totals 160/25 -> one record with inputTokens 60, outputTokens 15, cost 0

// next totals 20/2 after truncation -> cursor becomes 20/2, no negative record

// new b.jsonl at 40/5 -> one record with inputTokens 40, outputTokens 5
```

Also assert two changed files are summed into one `UsageRecord`, unchanged
cursors do not rewrite the store, timestamps carry the existing numeric UTC
offset format, and Claude records/fingerprints are untouched.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/core/track-usage.test.ts
```

Expected: FAIL because Codex cursor types and dispatch do not exist.

- [ ] **Step 3: Extend the backward-compatible store type**

Add:

```ts
export type CodexSessionCursor = {
  inputTokens: number;
  outputTokens: number;
};
```

and add:

```ts
codexSessions?: Record<string, CodexSessionCursor>;
```

beside the existing optional `seenSessions` field.

- [ ] **Step 4: Separate Claude and Codex collectors**

Keep the current Claude fingerprint algorithm in a Claude-specific helper. Add a
Codex helper that:

1. Reads current session totals.
2. Treats absent `codexSessions` as an uninitialized baseline, stores all
   current totals, and returns no record.
3. Computes `max(current - previous, 0)` independently for input and output.
4. Treats a decrease in either counter as a cursor reset for that file and does
   not record either counter from that file during that pass.
5. Sums positive deltas across files into one record with `cost: 0`.
6. Updates all observed cursors, including resets.

- [ ] **Step 5: Implement target resolution**

Resolve a qualified ID directly. For a tool target, first match the normalized
`CLAUDE_CONFIG_DIR` or `CODEX_HOME` against registered profile `configDir`
values; otherwise use `registry.activeProfiles[tool]`. Preserve the omitted
target's current Claude-first fallback for compatibility. Invalid or unmatched
targets return without changing storage.

- [ ] **Step 6: Generalize baseline seeding**

Implement:

```ts
seedProfileUsage(profileId, "claude", configDir)
// current Claude seenSessions behavior

seedProfileUsage(profileId, "codex", configDir)
// write codexSessions from current JSONL totals, append no record
```

Keep `seedSeenSessions` as a compatibility alias only if an existing test or
external import requires it; otherwise update all internal callers.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run src/core/track-usage.test.ts src/core/usage.test.ts
```

Expected: all new delta tests and existing summary tests PASS.

- [ ] **Step 8: Commit the tracking slice**

```powershell
git add src/types.ts src/core/track-usage.ts src/core/track-usage.test.ts
git commit -m "feat: track prospective codex token deltas"
```

---

### Task 3: Seed Registered Codex Profiles

**Files:**
- Modify: `src/lib/service.ts`
- Modify: `src/lib/service.integration.test.ts`

**Interfaces:**
- Consumes: `seedProfileUsage(profileId, tool, configDir)`
- Produces: initialized and newly added Codex profiles with a completed
  `codexSessions` baseline.

- [ ] **Step 1: Write failing service tests**

Add temporary Codex profiles with an existing session fixture. Assert both
`initializeRegistry` and `addProfile({ tool: "codex", ... })` create cursors and
leave `records` empty. Keep an existing Claude initialization assertion to prove
Claude seeding still runs.

- [ ] **Step 2: Run the focused integration tests and verify RED**

Run:

```powershell
npx vitest run src/lib/service.integration.test.ts
```

Expected: Codex usage baseline assertions FAIL.

- [ ] **Step 3: Replace Claude-only seeding branches**

During initialization call:

```ts
await seedProfileUsage(id, account.tool, account.configDir);
```

for every account. After both imported-profile and new-login add flows, call the
same function with the newly persisted qualified ID, tool, and config directory.
Remove comments that declare Codex tracking out of scope.

- [ ] **Step 4: Run focused service tests and verify GREEN**

Run:

```powershell
npx vitest run src/lib/service.integration.test.ts src/lib/service.rename.test.ts
```

Expected: baseline and rename usage-key tests PASS.

- [ ] **Step 5: Commit the seeding slice**

```powershell
git add src/lib/service.ts src/lib/service.integration.test.ts
git commit -m "feat: seed codex usage baselines"
```

---

### Task 4: Track Wrapped and Explicit Codex Runs

**Files:**
- Modify: `src/core/shell.ts`
- Modify: `src/core/shell.test.ts`
- Modify: `src/core/shell.integration.test.ts`
- Modify: `src/index.tsx`
- Modify: `src/index.test.ts`
- Modify: `src/commands.ts`

**Interfaces:**
- Consumes: `trackUsage("codex")` for shell wrappers.
- Consumes: `trackUsage(ref.id)` for `clausona run`.
- Internal command: `clausona _track-usage [claude|codex|qualified-id]`.

- [ ] **Step 1: Write failing shell rendering tests**

Assert the POSIX Codex wrapper contains this order:

```text
command codex "$@"
local rc=$?
clausona _track-usage codex
unset CODEX_HOME
return $rc
```

Assert PowerShell calls `clausona _track-usage codex *> $null` after the
application returns, preserves `$exitCode`, and restores the prior `CODEX_HOME`
inside `finally`.

- [ ] **Step 2: Write failing command/run tests**

Assert `_track-usage codex` calls `trackUsage("codex")`. Assert an explicit
`clausona run codex:work ...` calls `trackUsage("codex:work")` even when the
child command exits non-zero. Keep the equivalent Claude test.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
npx vitest run src/core/shell.test.ts src/core/shell.integration.test.ts src/index.test.ts
```

Expected: Codex tracking assertions FAIL.

- [ ] **Step 4: Update both generated shell wrappers**

Call tracking after Codex exits and before the wrapper restores the environment.
Redirect tracking output exactly as the Claude wrapper does. Capture and restore
the original exit status after the tracking subprocess.

- [ ] **Step 5: Route internal and explicit tracking targets**

Change the internal command to:

```ts
await trackUsage(args[0]);
```

and remove the Claude-only guard after explicit profile execution:

```ts
await trackUsage(ref.id).catch(() => {});
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
npx vitest run src/core/shell.test.ts src/core/shell.integration.test.ts src/index.test.ts
```

Expected: wrapper, status, environment, and explicit-run tests PASS.

- [ ] **Step 7: Commit the invocation slice**

```powershell
git add src/core/shell.ts src/core/shell.test.ts src/core/shell.integration.test.ts src/index.tsx src/index.test.ts src/commands.ts
git commit -m "feat: collect usage after codex runs"
```

---

### Task 5: Expose Codex Tokens in CLI and TUI Data

**Files:**
- Modify: `src/commands.ts`
- Modify: `src/lib/format.ts`
- Modify: `src/index.test.ts`
- Modify: `src/tui/App.test.tsx` if the dashboard snapshot asserts usage text.
- Modify: `README.md`

**Interfaces:**
- Consumes: existing `UsageSummary` with Codex `cost: 0`.
- Produces: Codex profile usage through `list`, `usage`, and `--json`.

- [ ] **Step 1: Write failing public-output tests**

Create a registry and usage store containing:

```ts
"codex:work": {
  records: [{
    ts: new Date().toISOString(),
    cost: 0,
    inputTokens: 1200,
    outputTokens: 75,
  }],
  codexSessions: {},
}
```

Assert:

- `clausona usage codex:work --period=all --json` returns those token totals.
- Text usage renders input and output totals without a support error.
- `clausona list` renders Codex token totals and omits the unsupported footnote.
- Claude list and usage formatting is unchanged.

- [ ] **Step 2: Run focused output tests and verify RED**

Run:

```powershell
npx vitest run src/index.test.ts src/tui/App.test.tsx
```

Expected: existing Codex guard/placeholder assertions FAIL.

- [ ] **Step 3: Remove public Codex restrictions**

Delete the Codex rejection in the `usage` command. In `renderList`, use the same
weekly `styledCount` rendering for Claude and Codex. Keep cost zero so
`styledCost(0)` displays the existing unavailable placeholder. Remove
`hasCodex` and the unsupported footnote.

- [ ] **Step 4: Update documentation**

Change the feature bullet to per-profile cost and tokens for Claude plus
tokens-only for Codex. Update the shell flow so both wrappers invoke
`_track-usage`. State that Codex dollar cost, cached-input breakout, and
historical backfill are not provided.

- [ ] **Step 5: Run focused output tests and verify GREEN**

Run:

```powershell
npx vitest run src/index.test.ts src/tui/App.test.tsx
```

Expected: Codex and Claude presentation tests PASS.

- [ ] **Step 6: Commit the presentation slice**

```powershell
git add src/commands.ts src/lib/format.ts src/index.test.ts src/tui/App.test.tsx README.md
git commit -m "feat: show codex token usage"
```

---

### Task 6: Full Verification and Compatibility Review

**Files:**
- Modify only files required to fix failures caused by Tasks 1-5.

**Interfaces:**
- Produces: a clean, buildable feature branch with no unrelated changes.

- [ ] **Step 1: Run formatting and static analysis**

Run:

```powershell
npm run lint
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 2: Run the complete suite**

Run:

```powershell
npm test
```

Expected: every supported-platform test passes; only existing platform-specific
skips are allowed.

- [ ] **Step 3: Build and inspect CLI output**

Run:

```powershell
npm run build
node dist/index.js usage --help
node dist/index.js list --json
git diff HEAD~5..HEAD --check
```

Expected: build exits 0, help documents the existing usage syntax, JSON list
includes Codex summaries, and diff check prints nothing.

- [ ] **Step 4: Review compatibility and privacy**

Inspect the final diff and confirm:

- JSONL parsing reads only token event counters.
- First pass for an upgraded profile seeds without recording history.
- Resumed sessions record only deltas.
- Codex cost stays zero/unavailable.
- Shell exit status and `CODEX_HOME` restoration are preserved.
- Claude tracker, usage migration, and rename behavior remain intact.
- No real profile is launched or modified as a smoke test.

- [ ] **Step 5: Commit verification fixes if needed**

If verification required code changes, stage only those exact files and commit:

```powershell
git commit -m "fix: harden codex usage tracking"
```

If no fixes were required, do not create an empty commit.
