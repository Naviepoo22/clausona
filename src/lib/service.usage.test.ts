import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredAccount, UsageStore } from "../types.js";

const { testHome } = vi.hoisted(() => ({
  testHome: `${process.cwd()}/.clausona-service-usage-test-${process.pid}`,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testHome };
});

import { addProfile, initializeRegistry } from "./service.js";

const storageDir = path.join(testHome, ".clausona");
const usagePath = path.join(storageDir, "usage.json");
const primaryDir = path.join(testHome, ".codex");

function tokenEvent(inputTokens: number, outputTokens: number) {
  return `${JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      },
    },
  })}\n`;
}

function writeCodexSession(configDir: string, name: string, inputTokens: number, outputTokens: number) {
  const sessionDir = path.join(configDir, "sessions", "2026", "07", "30");
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, name), tokenEvent(inputTokens, outputTokens), "utf8");
}

function readUsage(): UsageStore {
  return JSON.parse(readFileSync(usagePath, "utf8")) as UsageStore;
}

function primaryAccount(): DiscoveredAccount {
  return {
    tool: "codex",
    configDir: primaryDir,
    jsonPath: path.join(primaryDir, "auth.json"),
    email: "primary@example.com",
    keychainService: "",
    isPrimary: true,
  };
}

async function initializeCodex() {
  await initializeRegistry({
    accounts: [primaryAccount()],
    profileNames: { [primaryDir]: "default" },
    defaultProfile: "default",
  });
}

describe("Usage baseline seeding", () => {
  beforeEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    mkdirSync(primaryDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("seeds Claude provider limits without importing token usage", async () => {
    const claudeDir = path.join(testHome, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      path.join(claudeDir, ".credentials.json"),
      `${JSON.stringify({ claudeAiOauth: { accessToken: "test-claude-token" } })}\n`,
      "utf8",
    );
    writeFileSync(path.join(testHome, ".claude.json"), `${JSON.stringify({ projects: {} })}\n`, "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 25, resets_at: "2033-05-18T03:33:20.000Z" },
            seven_day: { utilization: 40, resets_at: "2033-05-23T22:26:40.000Z" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await initializeRegistry({
      accounts: [
        {
          tool: "claude",
          configDir: claudeDir,
          jsonPath: path.join(testHome, ".claude.json"),
          email: "claude@example.com",
          keychainService: "",
          isPrimary: true,
        },
      ],
      profileNames: { [claudeDir]: "default" },
      defaultProfile: "default",
    });

    expect(readUsage()["claude:default"]).toMatchObject({
      records: [],
      seenSessions: {},
      claudeRateLimits: {
        primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 2_000_000_000 },
        secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: 2_000_500_000 },
      },
    });
  });

  it("initializes existing Codex sessions as cursors without importing their tokens", async () => {
    writeCodexSession(primaryDir, "rollout-primary.jsonl", 500, 30);

    await initializeCodex();

    expect(readUsage()).toEqual({
      "codex:default": {
        records: [],
        codexSessions: {
          "2026/07/30/rollout-primary.jsonl": { inputTokens: 500, outputTokens: 30 },
        },
      },
    });
  });

  it("seeds an imported Codex profile without importing its existing tokens", async () => {
    await initializeCodex();
    const workDir = path.join(testHome, ".codex-work");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(
      path.join(workDir, "auth.json"),
      `${JSON.stringify({ tokens: { account_id: "acct_work" } })}\n`,
      "utf8",
    );
    writeCodexSession(workDir, "rollout-work.jsonl", 700, 45);

    await addProfile({ tool: "codex", name: "work", fromPath: workDir });

    expect(readUsage()["codex:work"]).toEqual({
      records: [],
      codexSessions: {
        "2026/07/30/rollout-work.jsonl": { inputTokens: 700, outputTokens: 45 },
      },
    });
  });
});
