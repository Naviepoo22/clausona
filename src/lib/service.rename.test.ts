import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry, UsageStore } from "../types.js";

const { testHome } = vi.hoisted(() => ({
  testHome: `${process.cwd()}/.clausona-rename-test-${process.pid}`,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

import { renameProfile } from "./service.js";

const storageDir = path.join(testHome, ".clausona");
const registryPath = path.join(storageDir, "profiles.json");
const usagePath = path.join(storageDir, "usage.json");

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readRegistry(): Registry {
  return JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
}

function readUsage(): UsageStore {
  return JSON.parse(readFileSync(usagePath, "utf8")) as UsageStore;
}

function seedRegistry(): Registry {
  const registry: Registry = {
    version: 2,
    primarySources: { claude: "C:\\Users\\test\\.claude" },
    activeProfiles: { claude: "claude:default" },
    profiles: {
      "claude:default": {
        tool: "claude",
        configDir: "C:\\Users\\test\\.claude",
        email: "person@example.com",
        isPrimary: true,
      },
    },
  };
  writeJson(registryPath, registry);
  writeJson(usagePath, {} satisfies UsageStore);
  return registry;
}

describe("renameProfile", () => {
  beforeEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    seedRegistry();
  });

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("renames an active primary profile without changing its data", async () => {
    const result = await renameProfile("claude:default", "personal");

    expect(result).toEqual({
      oldId: "claude:default",
      newId: "claude:personal",
      changed: true,
    });
    expect(readRegistry()).toEqual({
      version: 2,
      primarySources: { claude: "C:\\Users\\test\\.claude" },
      activeProfiles: { claude: "claude:personal" },
      profiles: {
        "claude:personal": {
          tool: "claude",
          configDir: "C:\\Users\\test\\.claude",
          email: "person@example.com",
          isPrimary: true,
        },
      },
    } satisfies Registry);
  });

  it("moves the complete usage history to the new profile identifier", async () => {
    const originalUsage: UsageStore[string] = {
      records: [{ ts: "2026-07-30T01:00:00.000Z", cost: 1.25, inputTokens: 120, outputTokens: 45 }],
      seenSessions: { session: "fingerprint" },
    };
    writeJson(usagePath, { "claude:default": originalUsage } satisfies UsageStore);

    await renameProfile("claude:default", "personal");

    expect(readUsage()).toEqual({ "claude:personal": originalUsage });
  });

  it("rejects an existing destination profile without changing either store", async () => {
    const registry = readRegistry();
    registry.profiles["claude:work"] = {
      tool: "claude",
      configDir: "C:\\Users\\test\\.claude-work",
      email: "work@example.com",
    };
    writeJson(registryPath, registry);
    const registryBefore = readFileSync(registryPath, "utf8");
    const usageBefore = readFileSync(usagePath, "utf8");

    await expect(renameProfile("claude:default", "work")).rejects.toThrow("already exists");

    expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
    expect(readFileSync(usagePath, "utf8")).toBe(usageBefore);
  });

  it("rejects stale destination usage without changing either store", async () => {
    writeJson(usagePath, {
      "claude:default": { records: [] },
      "claude:archived": {
        records: [{ ts: "2026-07-29T01:00:00.000Z", cost: 0.5, inputTokens: 10, outputTokens: 5 }],
      },
    } satisfies UsageStore);
    const registryBefore = readFileSync(registryPath, "utf8");
    const usageBefore = readFileSync(usagePath, "utf8");

    await expect(renameProfile("claude:default", "archived")).rejects.toThrow("Usage data");

    expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
    expect(readFileSync(usagePath, "utf8")).toBe(usageBefore);
  });

  it.each(["", "claude:personal"])("rejects invalid new label %j", async (newLabel) => {
    const registryBefore = readFileSync(registryPath, "utf8");
    const usageBefore = readFileSync(usagePath, "utf8");

    await expect(renameProfile("claude:default", newLabel)).rejects.toThrow(/non-empty|cannot contain/);

    expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
    expect(readFileSync(usagePath, "utf8")).toBe(usageBefore);
  });

  it("returns a no-op without rewriting either store", async () => {
    const registryBefore = readFileSync(registryPath, "utf8");
    const usageBefore = readFileSync(usagePath, "utf8");

    await expect(renameProfile("claude:default", "default")).resolves.toEqual({
      oldId: "claude:default",
      newId: "claude:default",
      changed: false,
    });

    expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);
    expect(readFileSync(usagePath, "utf8")).toBe(usageBefore);
  });

  it("keeps the active profile unchanged when renaming an inactive profile", async () => {
    const registry = readRegistry();
    registry.profiles["claude:work"] = {
      tool: "claude",
      configDir: "C:\\Users\\test\\.claude-work",
      email: "work@example.com",
      mergeSessions: true,
    };
    writeJson(registryPath, registry);

    await renameProfile("claude:work", "office");

    expect(readRegistry().activeProfiles.claude).toBe("claude:default");
    expect(readRegistry().profiles["claude:office"]).toEqual({
      tool: "claude",
      configDir: "C:\\Users\\test\\.claude-work",
      email: "work@example.com",
      mergeSessions: true,
    });
  });
});
