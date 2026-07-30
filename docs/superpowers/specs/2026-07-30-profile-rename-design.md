# Profile Rename Command Design

## Goal

Add a safe CLI operation for changing a Clausona profile's displayed label without moving or modifying its account data.

## Public Interface

```text
clausona rename <existing-profile> <new-label>
```

The existing profile accepts the same references as other profile commands: either a qualified identifier such as `claude:default` or an unambiguous bare label. The new label is always bare. For example:

```text
clausona rename claude:default personal
clausona rename codex:default work
```

The resulting identifiers are `claude:personal` and `codex:work`. A rename never changes the tool associated with a profile.

## Behavior

Renaming changes only Clausona's identifier for the profile. It preserves:

- the profile's configuration directory;
- credentials and account metadata;
- local session history;
- shared-resource links;
- merge-session configuration;
- primary-profile status.

Primary and secondary profiles can both be renamed.

The operation updates every persistent reference keyed by the old identifier:

1. Replace the key in `profiles.json` while preserving the `Profile` value.
2. Replace the matching entry in `activeProfiles` when the renamed profile is active.
3. Move the matching entry in `usage.json` to the new identifier.

The configuration directory is intentionally not renamed. Existing paths such as `~/.claude-default` remain valid after the displayed label changes.

## Validation and Errors

The command fails without modifying persistent state when:

- Clausona is not initialized;
- the existing profile cannot be resolved;
- the new label is empty;
- the new label contains `:`;
- the destination profile identifier already exists;
- the destination identifier already has a stale entry in `usage.json`.

Renaming a profile to its current label succeeds as a no-op and reports that the profile already has that label.

## Persistence

Registry and usage files continue to use the existing atomic temporary-file replacement helper. The service validates both destination keys before writing either file.

When usage data exists, the usage file is written before the registry. This avoids exposing a renamed registry entry whose history is still reachable only through the old identifier. If the later registry write fails, the command reports the error; cross-file transactional rollback is outside the current JSON-store architecture.

## Components

- `commands.ts`: registers `rename`, supplies help text, parses two operands, resolves the source profile, and formats the result.
- `service.ts`: owns validation and persistent registry/usage migration behind a `renameProfile` operation.
- CLI tests: verify public command behavior and validation.
- Service tests: verify primary-profile rename, active-profile migration, usage migration, collisions, no-op behavior, and data preservation.
- `README.md`: documents the new command.

## Testing Strategy

Development follows vertical test-driven slices:

1. Rename an active primary profile and preserve its profile data.
2. Migrate usage history.
3. Reject profile and usage collisions without changing either store.
4. Handle no-op and invalid-label cases.
5. Exercise the public command syntax and help output.

After focused tests pass, run lint, type-checking, the full test suite, and the production build.

## Non-Goals

- Moving or renaming configuration directories.
- Changing a profile from Claude to Codex or vice versa.
- Adding aliases.
- Renaming provider-side account or organization names.
- Automatically cleaning stale usage entries.
