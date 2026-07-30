# Profile Rename Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `clausona rename <existing-profile> <new-label>` so any profile, including a primary profile, can receive a new display identifier without moving its configuration directory.

**Architecture:** A service operation will validate the source and destination across both JSON stores, derive the new tool-qualified identifier, and atomically replace each affected store using the existing JSON writer. The command layer will resolve the source through the existing profile-reference parser, delegate persistence to the service, and format a concise success or no-op result.

**Tech Stack:** TypeScript 5.9, Node.js filesystem promises, Vitest 4, Biome, Ink-compatible CLI formatting.

## Global Constraints

- Preserve `configDir`, credentials, sessions, shared links, account metadata, merge-session configuration, and primary status.
- Never change the profile's tool prefix.
- Accept a qualified or unambiguous source reference; accept only a bare, non-empty destination label without `:`.
- Reject destination profile or stale usage-key collisions without modifying either store.
- Support primary and secondary profiles.
- Keep filesystem writes atomic through the existing temporary-file replacement helper.

---

## File Structure

- `src/lib/service.ts`: validate and persist the cross-store profile identifier migration.
- `src/commands.ts`: expose command syntax, help, source resolution, and user-facing output.
- `src/lib/service.rename.test.ts`: exercise persisted registry and usage behavior in an isolated mocked home directory.
- `src/index.test.ts`: exercise public help and argument validation that does not require real account state.
- `README.md`: document the command.

### Task 1: Persistent Rename Operation

**Files:**
- Create: `src/lib/service.rename.test.ts`
- Modify: `src/lib/service.ts`

**Interfaces:**
- Consumes: existing `Registry`, `UsageStore`, `loadRegistry()`, `loadUsageStore()`, `writeJson()`, `REGISTRY_PATH`, and `USAGE_PATH`.
- Produces: `renameProfile(id: string, newLabel: string): Promise<{ oldId: string; newId: string; changed: boolean }>`

- [ ] **Step 1: Write a failing persisted-state test for an active primary profile**

Create an isolated home before importing `service.ts`, write `profiles.json` and `usage.json`, then call:

```ts
const result = await renameProfile("claude:default", "personal");

expect(result).toEqual({
  oldId: "claude:default",
  newId: "claude:personal",
  changed: true,
});
expect(readRegistry()).toMatchObject({
  activeProfiles: { claude: "claude:personal" },
  profiles: {
    "claude:personal": {
      tool: "claude",
      configDir: "C:\\Users\\test\\.claude",
      email: "person@example.com",
      isPrimary: true,
    },
  },
});
expect(readRegistry().profiles).not.toHaveProperty("claude:default");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/lib/service.rename.test.ts
```

Expected: FAIL because `renameProfile` is not exported.

- [ ] **Step 3: Implement the minimum registry rename**

Add:

```ts
export async function renameProfile(id: string, newLabel: string) {
  const registry = await loadRegistry();
  if (!registry?.profiles[id]) throw new Error(`Profile '${id}' not found.`);
  if (newLabel === "" || newLabel.includes(":")) {
    throw new Error("New profile label must be non-empty and cannot contain ':'.");
  }

  const profile = registry.profiles[id];
  const newId = profileId(profile.tool, newLabel);
  if (newId === id) return { oldId: id, newId, changed: false };
  if (registry.profiles[newId]) throw new Error(`Profile '${newId}' already exists.`);

  registry.profiles[newId] = profile;
  delete registry.profiles[id];
  if (registry.activeProfiles[profile.tool] === id) {
    registry.activeProfiles[profile.tool] = newId;
  }
  await saveRegistry(registry);
  return { oldId: id, newId, changed: true };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npx vitest run src/lib/service.rename.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add a failing usage-migration test**

Seed usage under `claude:default` and assert that the complete value moves to `claude:personal`:

```ts
expect(readUsage()["claude:personal"]).toEqual(originalUsage);
expect(readUsage()).not.toHaveProperty("claude:default");
```

- [ ] **Step 6: Run the focused test and verify RED**

Run:

```powershell
npx vitest run src/lib/service.rename.test.ts
```

Expected: FAIL because usage remains under the old identifier.

- [ ] **Step 7: Implement usage migration before the registry write**

Load usage before mutating state. Reject an existing `usage[newId]`, otherwise move `usage[id]` when present and write `USAGE_PATH` before saving the registry:

```ts
const usage = await loadUsageStore();
if (usage[newId]) throw new Error(`Usage data for '${newId}' already exists.`);
if (usage[id]) {
  usage[newId] = usage[id];
  delete usage[id];
  await writeJson(USAGE_PATH, usage);
}
```

- [ ] **Step 8: Run the focused test and verify GREEN**

Run:

```powershell
npx vitest run src/lib/service.rename.test.ts
```

Expected: PASS.

- [ ] **Step 9: Add collision, validation, no-op, and inactive-profile cases one at a time**

Add and run one test per behavior:

```ts
await expect(renameProfile("claude:default", "work")).rejects.toThrow("already exists");
await expect(renameProfile("claude:default", "archived")).rejects.toThrow("Usage data");
await expect(renameProfile("claude:default", "")).rejects.toThrow("non-empty");
await expect(renameProfile("claude:default", "claude:personal")).rejects.toThrow("cannot contain ':'");
await expect(renameProfile("claude:default", "default")).resolves.toMatchObject({ changed: false });
```

For both collision cases, reread and compare both JSON files to their exact pre-call contents. For an inactive secondary profile, assert the active identifier remains unchanged.

- [ ] **Step 10: Run focused service tests**

Run:

```powershell
npx vitest run src/lib/service.rename.test.ts
```

Expected: all rename service tests PASS.

- [ ] **Step 11: Commit the service slice**

```powershell
git add src/lib/service.ts src/lib/service.rename.test.ts
git commit -m "feat: add persistent profile rename operation"
```

### Task 2: CLI Command and Documentation

**Files:**
- Modify: `src/commands.ts`
- Modify: `src/index.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `renameProfile(id, newLabel)` from Task 1 and existing `parseProfileRef()`.
- Produces: `clausona rename <existing-profile> <new-label>`.

- [ ] **Step 1: Write failing public help tests**

Add:

```ts
it("documents the rename command", async () => {
  expect(await runCommand("help", [])).toContain("rename <profile> <new-label>");
  expect(await runCommand("rename", ["--help"])).toContain(
    "clausona rename <existing-profile> <new-label>",
  );
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run src/index.test.ts
```

Expected: FAIL because rename is absent from help.

- [ ] **Step 3: Register help and command metadata**

Add `rename: { flags: [] }` to command validation, a `rename` subcommand help block, and this main-help entry:

```ts
["rename <profile> <new-label>", "Rename a profile label"],
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
npx vitest run src/index.test.ts
```

Expected: help tests PASS.

- [ ] **Step 5: Write failing argument-validation tests**

Add:

```ts
await expect(runCommand("rename", [])).rejects.toThrow(
  "Usage: clausona rename <existing-profile> <new-label>",
);
await expect(runCommand("rename", ["claude:default"])).rejects.toThrow(
  "Usage: clausona rename <existing-profile> <new-label>",
);
await expect(runCommand("rename", ["claude:default", "personal", "extra"])).rejects.toThrow(
  "Usage: clausona rename <existing-profile> <new-label>",
);
```

- [ ] **Step 6: Run the focused tests and verify RED**

Run:

```powershell
npx vitest run src/index.test.ts
```

Expected: FAIL because unknown commands currently fall through to general usage.

- [ ] **Step 7: Implement the command case**

Import `renameProfile` and add:

```ts
case "rename": {
  if (args.length !== 2) {
    throw new Error("Usage: clausona rename <existing-profile> <new-label>");
  }
  const [input, newLabel] = args;
  const registry = await loadRegistry();
  if (!registry) throw new Error("clausona is not initialized.");
  const ref = parseProfileRef(input, registry);
  const result = await renameProfile(ref.id, newLabel);
  if (!result.changed) return dim(`${result.oldId} already has label '${newLabel}'`);
  return success(`Renamed ${bold(result.oldId)} to ${bold(result.newId)}`);
}
```

- [ ] **Step 8: Run focused command tests**

Run:

```powershell
npx vitest run src/index.test.ts
```

Expected: all index tests PASS.

- [ ] **Step 9: Update README command documentation**

Add to Quick Start:

```text
clausona rename claude:default personal
```

Add to the Commands table:

```text
| `clausona rename <profile> <new-label>` | Rename a profile label without moving its data |
```

- [ ] **Step 10: Commit the CLI slice**

```powershell
git add src/commands.ts src/index.test.ts README.md
git commit -m "feat: expose profile rename command"
```

### Task 3: Full Verification

**Files:**
- Modify only if verification reveals a defect directly caused by this feature.

**Interfaces:**
- Consumes: completed rename service and CLI.
- Produces: a verified Windows-compatible build.

- [ ] **Step 1: Run formatting and static checks**

Run:

```powershell
npm run lint
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 2: Run the full test suite**

Run:

```powershell
npm test
```

Expected: all applicable Windows tests pass; zsh/bash-only tests may remain skipped.

- [ ] **Step 3: Build the distributable**

Run:

```powershell
npm run build
node dist/index.js rename --help
```

Expected: build exits 0 and the built CLI displays rename usage.

- [ ] **Step 4: Review the final diff**

Run:

```powershell
git diff main...HEAD --check
git status -sb
git log --oneline --decorate -5
```

Expected: no whitespace errors or uncommitted implementation changes.
