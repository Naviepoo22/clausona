import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { UsageRateLimits, UsageRateLimitWindow } from "../types.js";
import { keychainServiceForConfigDir } from "./paths.js";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const REQUEST_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

export type ClaudeRateLimitsReadResult = { status: "success"; rateLimits?: UsageRateLimits } | { status: "failure" };

function accessTokenFromCredentials(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const token = (value as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth?.accessToken;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

async function readAccessToken(configDir: string): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const resolvedConfigDir = await realpath(configDir).catch(() => configDir);
      const service = keychainServiceForConfigDir({ homeDir: homedir(), configDir: resolvedConfigDir });
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service, "-w"], {
        encoding: "utf8",
        timeout: REQUEST_TIMEOUT_MS,
      });
      return accessTokenFromCredentials(JSON.parse(stdout));
    }

    const raw = await readFile(path.join(configDir, ".credentials.json"), "utf8");
    return accessTokenFromCredentials(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function parseWindow(value: unknown, windowMinutes: number): UsageRateLimitWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { utilization?: unknown; resets_at?: unknown };
  const resetMs = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : Number.NaN;
  if (
    typeof raw.utilization !== "number" ||
    !Number.isFinite(raw.utilization) ||
    raw.utilization < 0 ||
    raw.utilization > 100 ||
    !Number.isFinite(resetMs) ||
    resetMs <= 0
  ) {
    return undefined;
  }
  return {
    usedPercent: raw.utilization,
    windowMinutes,
    resetsAt: Math.floor(resetMs / 1000),
  };
}

function parseRateLimits(value: unknown): UsageRateLimits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { five_hour?: unknown; seven_day?: unknown };
  const primary = parseWindow(raw.five_hour, 5 * 60);
  const secondary = parseWindow(raw.seven_day, 7 * 24 * 60);
  if (!primary && !secondary) return undefined;
  return {
    observedAt: new Date().toISOString(),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

export async function readClaudeRateLimits(configDir: string): Promise<ClaudeRateLimitsReadResult> {
  const accessToken = await readAccessToken(configDir);
  if (!accessToken) return { status: "success" };

  let response: Response;
  try {
    response = await fetch(CLAUDE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { status: "failure" };
  }

  if (!response.ok) {
    return response.status === 401 || response.status === 403 ? { status: "success" } : { status: "failure" };
  }

  try {
    return { status: "success", rateLimits: parseRateLimits(await response.json()) };
  } catch {
    return { status: "success" };
  }
}
