import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  home: `${process.env.TEMP ?? "C:/Windows/Temp"}/clausona-track-usage-tests`,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => testState.home };
});

import { runCommand } from "../commands.js";
import { trackUsage } from "./track-usage.js";

const clausonaDir = path.join(testState.home, ".clausona");
const usagePath = path.join(clausonaDir, "usage.json");
const codexDefaultDir = path.join(testState.home, ".codex");

function tokenEvent(
  inputTokens: number,
  outputTokens: number,
  rateLimits: unknown = null,
  timestamp = "2026-07-30T03:36:22.278Z",
) {
  return `${JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens + outputTokens,
        },
      },
      rate_limits: rateLimits,
    },
  })}\n`;
}

async function writeRegistry(profiles?: Record<string, object>) {
  const registeredProfiles = profiles ?? {
    "codex:default": {
      tool: "codex",
      configDir: codexDefaultDir,
      email: "codex@example.com",
      isPrimary: true,
    },
  };
  await mkdir(clausonaDir, { recursive: true });
  await writeFile(
    path.join(clausonaDir, "profiles.json"),
    `${JSON.stringify({
      version: 2,
      primarySources: { codex: codexDefaultDir },
      activeProfiles: { codex: Object.keys(registeredProfiles)[0] },
      profiles: registeredProfiles,
    })}\n`,
    "utf8",
  );
}

async function writeSession(configDir: string, name: string, inputTokens: number, outputTokens: number) {
  const dayDir = path.join(configDir, "sessions", "2026", "07", "30");
  await mkdir(dayDir, { recursive: true });
  const file = path.join(dayDir, name);
  await writeFile(file, tokenEvent(inputTokens, outputTokens), "utf8");
  return file;
}

async function readUsage(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(usagePath, "utf8")) as Record<string, any>;
}

beforeEach(async () => {
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  await rm(testState.home, { force: true, recursive: true });
  await writeRegistry();
});

afterEach(async () => {
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  await rm(testState.home, { force: true, recursive: true });
});

describe("trackUsage for Codex", () => {
  it("stores the latest provider limits without creating a token record", async () => {
    const file = await writeSession(codexDefaultDir, "rollout-a.jsonl", 100, 10);
    await appendFile(
      file,
      tokenEvent(
        100,
        10,
        {
          plan_type: "plus",
          primary: { used_percent: 66, window_minutes: 300, resets_at: 1_754_000_000 },
          secondary: { used_percent: 10, window_minutes: 10_080, resets_at: 1_754_500_000 },
        },
        "2026-07-30T03:37:22.278Z",
      ),
      "utf8",
    );

    await trackUsage("codex");

    expect((await readUsage())["codex:default"]).toEqual({
      records: [],
      codexSessions: {
        "2026/07/30/rollout-a.jsonl": { inputTokens: 100, outputTokens: 10 },
      },
      codexRateLimits: {
        observedAt: "2026-07-30T03:37:22.278Z",
        planType: "plus",
        primary: { usedPercent: 66, windowMinutes: 300, resetsAt: 1_754_000_000 },
        secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: 1_754_500_000 },
      },
    });
  });

  it("clears a previous limit snapshot when the newest session has none", async () => {
    const first = await writeSession(codexDefaultDir, "rollout-a.jsonl", 100, 10);
    await appendFile(
      first,
      tokenEvent(100, 10, {
        primary: { used_percent: 66, window_minutes: 300, resets_at: 2_000_000_000 },
      }),
      "utf8",
    );
    await trackUsage("codex");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeSession(codexDefaultDir, "rollout-b.jsonl", 20, 2);

    await trackUsage("codex");

    const profile = (await readUsage())["codex:default"];
    expect(profile.codexRateLimits).toBeUndefined();
    expect(profile.records).toEqual([expect.objectContaining({ cost: 0, inputTokens: 20, outputTokens: 2 })]);
  });

  it("establishes a first-pass baseline without importing existing tokens", async () => {
    await writeSession(codexDefaultDir, "rollout-a.jsonl", 100, 10);

    await trackUsage("codex");

    expect(await readUsage()).toEqual({
      "codex:default": {
        records: [],
        codexSessions: {
          "2026/07/30/rollout-a.jsonl": { inputTokens: 100, outputTokens: 10 },
        },
      },
    });
  });

  it("records only the positive delta when an existing session grows", async () => {
    const file = await writeSession(codexDefaultDir, "rollout-a.jsonl", 100, 10);
    await trackUsage("codex");
    await appendFile(file, tokenEvent(160, 25), "utf8");

    await trackUsage("codex");

    const profile = (await readUsage())["codex:default"];
    expect(profile.codexSessions).toEqual({
      "2026/07/30/rollout-a.jsonl": { inputTokens: 160, outputTokens: 25 },
    });
    expect(profile.records).toHaveLength(1);
    expect(profile.records[0]).toMatchObject({
      cost: 0,
      inputTokens: 60,
      outputTokens: 15,
    });
    expect(profile.records[0].tz).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(Number.isNaN(Date.parse(profile.records[0].ts))).toBe(false);
  });

  it("resets a decreased cursor without recording negative usage", async () => {
    const file = await writeSession(codexDefaultDir, "rollout-a.jsonl", 100, 10);
    await trackUsage("codex");
    await writeFile(file, tokenEvent(20, 2), "utf8");

    await trackUsage("codex");

    expect((await readUsage())["codex:default"]).toEqual({
      records: [],
      codexSessions: {
        "2026/07/30/rollout-a.jsonl": { inputTokens: 20, outputTokens: 2 },
      },
    });
  });

  it("records the complete totals for a session created after the baseline", async () => {
    await trackUsage("codex");
    await writeSession(codexDefaultDir, "rollout-new.jsonl", 40, 5);

    await trackUsage("codex");

    expect((await readUsage())["codex:default"].records).toEqual([
      expect.objectContaining({ cost: 0, inputTokens: 40, outputTokens: 5 }),
    ]);
  });

  it("aggregates changes from multiple sessions into one usage record", async () => {
    const first = await writeSession(codexDefaultDir, "rollout-a.jsonl", 100, 10);
    const second = await writeSession(codexDefaultDir, "rollout-b.jsonl", 200, 20);
    await trackUsage("codex");
    await appendFile(first, tokenEvent(130, 14), "utf8");
    await appendFile(second, tokenEvent(250, 27), "utf8");

    await trackUsage("codex");

    expect((await readUsage())["codex:default"].records).toEqual([
      expect.objectContaining({ cost: 0, inputTokens: 80, outputTokens: 11 }),
    ]);
  });

  it("uses CODEX_HOME to attribute a tool-targeted pass to a registered secondary profile", async () => {
    const workDir = path.join(testState.home, ".codex-work");
    await writeRegistry({
      "codex:default": {
        tool: "codex",
        configDir: codexDefaultDir,
        email: "default@example.com",
        isPrimary: true,
      },
      "codex:work": {
        tool: "codex",
        configDir: workDir,
        email: "work@example.com",
      },
    });
    process.env.CODEX_HOME = workDir;
    await writeSession(workDir, "rollout-work.jsonl", 70, 8);

    await trackUsage("codex");

    expect(await readUsage()).toEqual({
      "codex:work": {
        records: [],
        codexSessions: {
          "2026/07/30/rollout-work.jsonl": { inputTokens: 70, outputTokens: 8 },
        },
      },
    });
  });

  it("does not attribute an unregistered CODEX_HOME to the active profile", async () => {
    const externalDir = path.join(testState.home, ".codex-external");
    process.env.CODEX_HOME = externalDir;
    await writeSession(externalDir, "rollout-external.jsonl", 70, 8);
    await writeFile(usagePath, "{}\n", "utf8");

    await trackUsage("codex");

    expect(await readUsage()).toEqual({});
  });

  it("routes the internal Codex tracking command instead of falling back to active Claude", async () => {
    await writeRegistry({
      "claude:default": {
        tool: "claude",
        configDir: path.join(testState.home, ".claude"),
        email: "claude@example.com",
        isPrimary: true,
      },
      "codex:default": {
        tool: "codex",
        configDir: codexDefaultDir,
        email: "codex@example.com",
        isPrimary: true,
      },
    });
    const registry = JSON.parse(await readFile(path.join(clausonaDir, "profiles.json"), "utf8")) as Record<string, any>;
    registry.activeProfiles = { claude: "claude:default", codex: "codex:default" };
    await writeFile(path.join(clausonaDir, "profiles.json"), `${JSON.stringify(registry)}\n`, "utf8");
    await writeSession(codexDefaultDir, "rollout-codex.jsonl", 90, 9);

    await runCommand("_track-usage", ["codex"]);

    expect(await readUsage()).toEqual({
      "codex:default": {
        records: [],
        codexSessions: {
          "2026/07/30/rollout-codex.jsonl": { inputTokens: 90, outputTokens: 9 },
        },
      },
    });
  });

  it("returns Codex token summaries through the public usage command", async () => {
    await writeFile(
      usagePath,
      `${JSON.stringify({
        "codex:default": {
          records: [
            {
              ts: "2026-07-30T08:00:00+08:00",
              tz: "+08:00",
              cost: 0,
              inputTokens: 1200,
              outputTokens: 75,
            },
          ],
          codexSessions: {},
          codexRateLimits: {
            observedAt: "2026-07-30T03:37:22.278Z",
            primary: { usedPercent: 66, windowMinutes: 300, resetsAt: 1_754_000_000 },
            secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: 1_754_500_000 },
          },
        },
      })}\n`,
      "utf8",
    );

    const output = await runCommand("usage", ["codex:default", "--period=all", "--json"]);

    expect(JSON.parse(output)).toEqual({
      cost: 0,
      inputTokens: 1200,
      outputTokens: 75,
      rateLimits: {
        observedAt: "2026-07-30T03:37:22.278Z",
        primary: { usedPercent: 66, windowMinutes: 300, resetsAt: 1_754_000_000 },
        secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: 1_754_500_000 },
      },
    });
  });
});
