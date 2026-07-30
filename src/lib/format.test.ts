import { describe, expect, it } from "vitest";
import type { ProfileListItem } from "../types.js";
import { renderList, renderUsageSummary } from "./format.js";

function emptySummary() {
  return { cost: 0, inputTokens: 0, outputTokens: 0 };
}

describe("renderList", () => {
  it("renders Codex weekly token totals without an unsupported footnote", () => {
    const item: ProfileListItem = {
      name: "codex:work",
      tool: "codex",
      email: "work@example.com",
      configDir: "C:/Users/test/.codex-work",
      isPrimary: false,
      isActive: true,
      rateLimits: {
        observedAt: "2026-07-30T03:37:22.278Z",
        primary: { usedPercent: 66, windowMinutes: 300, resetsAt: 2_000_000_000 },
        secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: 2_000_500_000 },
      },
      today: emptySummary(),
      week: { cost: 0, inputTokens: 1200, outputTokens: 75 },
      month: emptySummary(),
      total: emptySummary(),
    };

    const output = renderList([item]);

    expect(output).toContain("1,200");
    expect(output).toContain("75");
    expect(output).toContain("5h 34%");
    expect(output).toContain("7d 90%");
    expect(output).not.toContain("usage tracking not supported for codex");
  });

  it("renders Claude provider limits in the remaining column", () => {
    const item: ProfileListItem = {
      name: "claude:work",
      tool: "claude",
      email: "work@example.com",
      configDir: "C:/Users/test/.claude-work",
      isPrimary: false,
      isActive: true,
      rateLimits: {
        observedAt: "2026-07-30T03:37:22.278Z",
        primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 2_000_000_000 },
        secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: 2_000_500_000 },
      },
      today: emptySummary(),
      week: emptySummary(),
      month: emptySummary(),
      total: emptySummary(),
    };

    const output = renderList([item]);

    expect(output).toContain("5h 75%");
    expect(output).toContain("7d 60%");
  });
});

describe("renderUsageSummary", () => {
  it("shows remaining Codex capacity for both provider windows", () => {
    const output = renderUsageSummary(
      {
        cost: 0,
        inputTokens: 1200,
        outputTokens: 75,
        rateLimits: {
          observedAt: "2026-07-30T03:37:22.278Z",
          primary: { usedPercent: 66, windowMinutes: 300, resetsAt: 2_000_000_000 },
          secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: 2_000_500_000 },
        },
      },
      "codex:work",
      "all",
    );

    expect(output).toContain("5h remaining");
    expect(output).toContain("34%");
    expect(output).toContain("7d remaining");
    expect(output).toContain("90%");
  });

  it("shows a reset window as unavailable instead of stale usage", () => {
    const output = renderUsageSummary(
      {
        cost: 0,
        inputTokens: 0,
        outputTokens: 0,
        rateLimits: {
          observedAt: "2026-07-30T03:37:22.278Z",
          primary: { usedPercent: 66, windowMinutes: 300, resetsAt: 1 },
        },
      },
      "codex:work",
      "all",
    );

    expect(output).toContain("5h remaining");
    expect(output).toContain("—");
  });
});
