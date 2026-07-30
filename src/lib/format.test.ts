import { describe, expect, it } from "vitest";
import type { ProfileListItem } from "../types.js";
import { renderList } from "./format.js";

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
      today: emptySummary(),
      week: { cost: 0, inputTokens: 1200, outputTokens: 75 },
      month: emptySummary(),
      total: emptySummary(),
    };

    const output = renderList([item]);

    expect(output).toContain("1,200");
    expect(output).toContain("75");
    expect(output).not.toContain("usage tracking not supported for codex");
  });
});
