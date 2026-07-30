# Codex Token Usage Tracking Design

## Goal

Extend Clausona's local per-profile usage tracking to OpenAI Codex CLI. Codex
profiles will report input and output tokens through the existing `list` and
`usage` commands without importing activity that happened before tracking was
enabled.

## User-Visible Behavior

After a Codex command finishes, Clausona records the new input and output tokens
for the Codex profile that ran it. The existing commands then include those
tokens:

```text
clausona list
clausona usage codex:default --period=today
clausona usage codex:work --period=all
```

Codex does not expose a reliable dollar cost in its local session logs. Codex
cost therefore remains unavailable and renders with the existing zero-cost
placeholder. Input and output columns show the tracked token counts. The current
“usage tracking not supported for codex” footnote and command error are removed.

Codex's `input_tokens` counter includes cached input tokens. Clausona presents
that counter as input usage to match the existing two-column input/output model.
It does not add separate cached-input or reasoning-output columns.

## Source Data

Each Codex profile owns a `CODEX_HOME`. Codex writes session JSONL files below:

```text
<CODEX_HOME>/sessions/<year>/<month>/<day>/rollout-*.jsonl
```

The files contain `event_msg` records whose payload type is `token_count`.
Non-null payloads expose cumulative `total_token_usage.input_tokens` and
`total_token_usage.output_tokens` values for that session. Local inspection
confirmed that these totals increase monotonically during normal sessions.

Clausona reads only the latest valid cumulative total from each session file.
It ignores message content and does not copy prompts, responses, working
directories, or other session metadata into its usage store.

## Tracking Model

The usage store gains an optional Codex cursor map for each profile:

```ts
type CodexSessionCursor = {
  inputTokens: number;
  outputTokens: number;
};

type UsageProfile = {
  records: UsageRecord[];
  seenSessions?: Record<string, string>; // existing Claude fingerprints
  codexSessions?: Record<string, CodexSessionCursor>;
};
```

The cursor key is the session file path relative to the profile's `sessions`
directory. Relative keys keep the store stable when a profile directory is
moved while avoiding collisions between same-named files in different date
directories.

No store-version migration is required. Existing `usage.json` files remain
valid because `codexSessions` is optional. Claude continues using
`seenSessions` unchanged.

## Seeding Existing Sessions

Initialization and profile creation establish a baseline for every existing
Codex session file:

1. Find JSONL files below the profile's `sessions` directory.
2. Read the latest valid cumulative input/output totals from each file.
3. Save those values as cursors.
4. Do not append usage records.

This makes tracking prospective: sessions that existed before the feature was
enabled contribute no historical tokens. If an old session is resumed later,
only the increase beyond its seeded cursor is recorded.

A missing sessions directory or a session file without a valid token event is a
valid empty baseline.

Existing Clausona installations also need a prospective baseline. On the first
Codex tracking pass for a profile whose `codexSessions` map is absent, Clausona
creates the map from all current session totals and returns without appending a
usage record. An existing empty map is a completed baseline, so the first new
session created afterward is counted normally.

## Recording New Usage

Tracking runs after a wrapped `codex` command and after
`clausona run codex:<profile> ...`:

1. Resolve the exact Codex profile that supplied `CODEX_HOME`.
2. Lazily seed and stop if this profile has never established a Codex baseline.
3. Read the latest token totals from its session files.
4. For every file, compare the totals with its stored cursor.
5. Append one `UsageRecord` containing the sum of all positive input and output
   deltas found during that tracking pass.
6. Set `cost` to zero, use the existing local timestamp and timezone format, and
   update every observed cursor.
7. Atomically replace `usage.json` only when a cursor or usage record changed.

A newly created session has no cursor, so its complete final totals are the
delta. A resumed session has a cursor, so only newly consumed tokens are
recorded. Summing changes into one record gives period reporting the same
invocation-end semantics as the current Claude tracker.

If a counter decreases because a file was truncated, replaced, or written by an
incompatible Codex version, Clausona updates the baseline but records no
negative usage. A later increase is measured from the new baseline.

## Profile Attribution and Shell Integration

The shell wrappers already set `CODEX_HOME` before launching Codex. They will
invoke the internal usage command after Codex exits but before restoring or
removing that environment variable. This lets the tracker match the resolved
configuration directory to the registered profile, including primary profiles
and an explicitly supplied `CODEX_HOME`.

The wrapper preserves Codex's original exit status even if tracking fails.
Tracking remains silent in shell integration, matching Claude behavior.

The `clausona run` path already knows the qualified profile identifier and will
pass it directly to the tracker. Claude tracking through both entry points
continues unchanged.

## Parsing and Performance

The Codex parser is isolated from registry and persistence logic. It accepts a
session file and returns the last valid input/output total or `null`.

Session files can be large. The reader searches backward from the end in bounded
chunks until it finds a valid non-null `token_count` event. It expands the
window when the final JSONL record is incomplete or no token event is present.
This avoids reparsing complete conversations after every command while still
supporting unusually long final lines.

Directory traversal and file parsing are best-effort per file. One unreadable or
malformed session does not prevent other sessions from being counted.

## Errors and Compatibility

- Missing registry, profile, configuration directory, or sessions directory:
  return without recording usage.
- Unreadable file or malformed JSONL line: skip it and continue.
- Missing, non-finite, negative, or structurally invalid counters: ignore that
  event.
- Incomplete final line: continue searching earlier complete lines.
- Decreasing counters: reset that cursor without recording a negative delta.
- Usage-store write failure: leave the previous atomic file intact.
- Codex process failure: still attempt tracking, then return Codex's original
  exit status.

The parser depends only on the observed JSON event fields. Unknown fields are
ignored so newer Codex versions can extend their events without breaking
Clausona.

## Components

- `src/core/track-usage.ts`: dispatch Claude and Codex tracking, seed profile
  baselines, compute cursor deltas, and persist usage records.
- A focused Codex session parser module under `src/core/`: traverse session
  files and extract their latest cumulative token totals.
- `src/types.ts`: define the optional Codex cursor shape.
- `src/core/shell.ts`: call tracking after wrapped Codex invocations on
  POSIX shells and PowerShell while preserving exit and environment behavior.
- `src/index.tsx`: track explicit Codex profile runs.
- `src/commands.ts`: route the internal tracker target and permit Codex in the
  public `usage` command.
- `src/lib/service.ts`: seed Codex cursors during initialization and profile
  creation.
- `src/lib/format.ts`: render Codex tokens and remove the unsupported footnote.
- `README.md`: document tracking for both tools and the tokens-only Codex
  limitation.

## Testing Strategy

Development proceeds in test-driven slices:

1. Parse the latest valid Codex totals from representative JSONL fixtures,
   including null token events, malformed lines, and incomplete final lines.
2. Seed existing session cursors without creating usage records.
3. Lazily seed an upgraded installation on its first tracking pass.
4. Record the full totals for a new session created after seeding.
5. Record only the positive delta when an existing session is resumed.
6. Aggregate multiple changed sessions into one record and handle counter
   resets without negative usage.
7. Attribute primary, secondary, active, explicit, and environment-selected
   Codex profiles correctly.
8. Verify POSIX and PowerShell wrappers call tracking after Codex while
   preserving exit codes and restoring `CODEX_HOME`.
9. Verify `clausona run`, `list`, and `usage` expose Codex tokens and no longer
   report Codex as unsupported.
10. Run regression tests for Claude tracking, profile rename usage keys, shell
   integration, and usage-period summaries.

Final verification runs lint, type-checking, the complete test suite, the
production build, and focused CLI help/output checks.

## Non-Goals

- Importing historical Codex usage.
- Estimating Codex dollar cost.
- Separating cached input, cache-write input, or reasoning output tokens.
- Tracking provider-side rate limits or subscription quotas.
- Reading prompt or response content.
- Introducing a background process, daemon, proxy, or SQLite dependency.
