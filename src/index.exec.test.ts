import { describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  spawnCommandSync: vi.fn(() => ({ status: 7, signal: null, stdout: null, stderr: null })),
  trackUsage: vi.fn(async () => {}),
}));

vi.mock("./core/process.js", async () => {
  const actual = await vi.importActual<typeof import("./core/process.js")>("./core/process.js");
  return { ...actual, spawnCommandSync: fakes.spawnCommandSync };
});

vi.mock("./core/track-usage.js", () => ({
  trackUsage: fakes.trackUsage,
}));

vi.mock("./lib/service.js", async () => {
  const actual = await vi.importActual<typeof import("./lib/service.js")>("./lib/service.js");
  return {
    ...actual,
    loadRegistry: vi.fn(async () => ({
      version: 2,
      primarySources: { codex: "C:/Users/test/.codex" },
      activeProfiles: { codex: "codex:work" },
      profiles: {
        "codex:work": {
          tool: "codex",
          configDir: "C:/Users/test/.codex-work",
          email: "work@example.com",
        },
      },
    })),
    resolveProfileEnv: vi.fn(async () => ({
      binary: "codex",
      env: { ...process.env, CODEX_HOME: "C:/Users/test/.codex-work" },
    })),
  };
});

import { executeProfileRun } from "./index.js";

describe("executeProfileRun", () => {
  it("tracks the exact Codex profile even when the child exits non-zero", async () => {
    const status = await executeProfileRun("codex:work", ["--version"]);

    expect(status).toBe(7);
    expect(fakes.spawnCommandSync).toHaveBeenCalledWith("codex", ["--version"], {
      stdio: "inherit",
      env: expect.objectContaining({ CODEX_HOME: "C:/Users/test/.codex-work" }),
    });
    expect(fakes.trackUsage).toHaveBeenCalledWith("codex:work");
  });
});
