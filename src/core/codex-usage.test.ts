import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexSessionTotals, readCodexSessionUsage, readLatestCodexTokenTotals } from "./codex-usage.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "clausona-codex-usage-"));
  tempDirs.push(dir);
  return dir;
}

function tokenEvent(
  inputTokens: unknown,
  outputTokens: unknown,
  rateLimits: unknown = null,
  timestamp = "2026-07-30T03:36:22.278Z",
) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 50,
          output_tokens: outputTokens,
          reasoning_output_tokens: 3,
          total_tokens: 999,
        },
      },
      rate_limits: rateLimits,
    },
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("readLatestCodexTokenTotals", () => {
  it("returns the newest valid cumulative input and output counters", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "session.jsonl");
    const lines = [
      tokenEvent(100, 10),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
      tokenEvent(125, 17),
      '{"type":"event_msg","payload":',
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    await expect(readLatestCodexTokenTotals(file)).resolves.toEqual({
      inputTokens: 125,
      outputTokens: 17,
    });
  });

  it("expands beyond the initial tail window when newer lines contain no token event", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "large-session.jsonl");
    const unrelated = JSON.stringify({
      type: "event_msg",
      payload: { type: "message", text: "x".repeat(70 * 1024) },
    });
    await writeFile(file, `${tokenEvent(44, 9)}\n${unrelated}\n`, "utf8");

    await expect(readLatestCodexTokenTotals(file)).resolves.toEqual({
      inputTokens: 44,
      outputTokens: 9,
    });
  });

  it.each([
    ["negative input", -1, 2],
    ["negative output", 1, -2],
    ["string input", "1", 2],
    ["string output", 1, "2"],
    ["missing input", undefined, 2],
    ["missing output", 1, undefined],
  ])("rejects %s counters", async (_label, inputTokens, outputTokens) => {
    const dir = await makeTempDir();
    const file = path.join(dir, "invalid.jsonl");
    await writeFile(file, tokenEvent(inputTokens, outputTokens), "utf8");

    await expect(readLatestCodexTokenTotals(file)).resolves.toBeNull();
  });

  it("returns null when no valid token event exists", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "empty.jsonl");
    await writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id: "session-1" } })}\n`, "utf8");

    await expect(readLatestCodexTokenTotals(file)).resolves.toBeNull();
  });
});

describe("readCodexSessionTotals", () => {
  it("discovers nested JSONL sessions and uses slash-normalized relative keys", async () => {
    const configDir = await makeTempDir();
    const dayDir = path.join(configDir, "sessions", "2026", "07", "30");
    await mkdir(dayDir, { recursive: true });
    await writeFile(path.join(dayDir, "rollout-a.jsonl"), tokenEvent(80, 12), "utf8");
    await writeFile(path.join(dayDir, "ignored.txt"), tokenEvent(999, 999), "utf8");

    await expect(readCodexSessionTotals(configDir)).resolves.toEqual({
      "2026/07/30/rollout-a.jsonl": { inputTokens: 80, outputTokens: 12 },
    });
  });

  it("returns an empty map when the sessions directory is missing", async () => {
    const configDir = await makeTempDir();

    await expect(readCodexSessionTotals(configDir)).resolves.toEqual({});
  });
});

describe("readCodexSessionUsage", () => {
  it("returns the newest valid provider rate-limit snapshot alongside session totals", async () => {
    const configDir = await makeTempDir();
    const dayDir = path.join(configDir, "sessions", "2026", "07", "30");
    await mkdir(dayDir, { recursive: true });
    const rateLimits = {
      plan_type: "plus",
      primary: { used_percent: 66, window_minutes: 300, resets_at: 1_754_000_000 },
      secondary: { used_percent: 10, window_minutes: 10_080, resets_at: 1_754_500_000 },
    };
    await writeFile(
      path.join(dayDir, "rollout-a.jsonl"),
      [
        tokenEvent(80, 12, rateLimits, "2026-07-30T03:36:22.278Z"),
        tokenEvent(90, 14, null, "2026-07-30T03:37:22.278Z"),
      ].join("\n"),
      "utf8",
    );

    await expect(readCodexSessionUsage(configDir)).resolves.toEqual({
      sessions: {
        "2026/07/30/rollout-a.jsonl": { inputTokens: 90, outputTokens: 14 },
      },
      rateLimits: {
        observedAt: "2026-07-30T03:36:22.278Z",
        planType: "plus",
        primary: { usedPercent: 66, windowMinutes: 300, resetsAt: 1_754_000_000 },
        secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: 1_754_500_000 },
      },
    });
  });

  it("rejects an implausibly future provider timestamp", async () => {
    const configDir = await makeTempDir();
    const dayDir = path.join(configDir, "sessions", "2026", "07", "30");
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      path.join(dayDir, "rollout-a.jsonl"),
      tokenEvent(
        80,
        12,
        {
          primary: { used_percent: 66, window_minutes: 300, resets_at: 2_000_000_000 },
        },
        "2099-07-30T03:36:22.278Z",
      ),
      "utf8",
    );

    await expect(readCodexSessionUsage(configDir)).resolves.toEqual({
      sessions: {
        "2026/07/30/rollout-a.jsonl": { inputTokens: 80, outputTokens: 12 },
      },
    });
  });
});
