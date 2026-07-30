import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readClaudeRateLimits } from "./claude-usage.js";

const tempDirs: string[] = [];

async function makeConfigDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "clausona-claude-usage-"));
  tempDirs.push(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, ".credentials.json"),
    `${JSON.stringify({ claudeAiOauth: { accessToken: "test-access-token" } })}\n`,
    "utf8",
  );
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("readClaudeRateLimits", () => {
  it("reads profile credentials and maps provider utilization without exposing the token", async () => {
    const configDir = await makeConfigDir();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          five_hour: { utilization: 66, resets_at: "2033-05-18T03:33:20.000Z" },
          seven_day: { utilization: 10, resets_at: "2033-05-23T22:26:40.000Z" },
          extra_usage: { is_enabled: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await readClaudeRateLimits(configDir);

    expect(result).toMatchObject({
      status: "success",
      rateLimits: {
        primary: { usedPercent: 66, windowMinutes: 300, resetsAt: 2_000_000_000 },
        secondary: { usedPercent: 10, windowMinutes: 10_080, resetsAt: 2_000_500_000 },
      },
    });
    expect(result.status === "success" && result.rateLimits?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(result)).not.toContain("test-access-token");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-access-token",
          "anthropic-beta": "oauth-2025-04-20",
        }),
      }),
    );
  });

  it("rejects malformed provider windows", async () => {
    const configDir = await makeConfigDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 101, resets_at: "2033-05-18T03:33:20.000Z" },
            seven_day: { utilization: "10", resets_at: "not-a-date" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    await expect(readClaudeRateLimits(configDir)).resolves.toEqual({ status: "success" });
  });

  it("returns no snapshot when the provider rejects the credentials", async () => {
    const configDir = await makeConfigDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 401 })),
    );

    await expect(readClaudeRateLimits(configDir)).resolves.toEqual({ status: "success" });
  });

  it("distinguishes a transient provider failure from an authoritative empty result", async () => {
    const configDir = await makeConfigDir();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );

    await expect(readClaudeRateLimits(configDir)).resolves.toEqual({ status: "failure" });
  });
});
