import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Registry, ToolName, UsageStore } from "../types.js";
import { readCodexSessionTotals } from "./codex-usage.js";
import { claudeJsonPathForConfigDir } from "./paths.js";

const CLAUSONA_DIR = path.join(homedir(), ".clausona");
const REGISTRY_PATH = path.join(CLAUSONA_DIR, "profiles.json");
const USAGE_PATH = path.join(CLAUSONA_DIR, "usage.json");

async function readJson<T>(targetPath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(targetPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(targetPath: string, value: unknown) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, targetPath);
}

async function claudeProjects(configDir: string) {
  const home = homedir();
  const defaultClaude = await realpath(path.join(home, ".claude")).catch(() => path.join(home, ".claude"));
  const resolved = await realpath(configDir).catch(() => configDir);
  const cjsonPath =
    resolved === defaultClaude
      ? claudeJsonPathForConfigDir({ homeDir: home, configDir: path.join(home, ".claude") })
      : claudeJsonPathForConfigDir({ homeDir: home, configDir });
  const cdata = await readJson<Record<string, unknown>>(cjsonPath, {});
  return cdata.projects as Record<string, Record<string, unknown>> | undefined;
}

async function normalizedPath(targetPath: string) {
  const resolved = await realpath(targetPath).catch(() => path.resolve(targetPath));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function resolveProfileId(registry: Registry, target?: string) {
  if (target && registry.profiles[target]) return target;

  const tool: ToolName | null =
    target === "claude" || target === "codex"
      ? target
      : target
        ? null
        : registry.activeProfiles.claude
          ? "claude"
          : registry.activeProfiles.codex
            ? "codex"
            : null;
  if (!tool) return null;

  const envDir = tool === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  if (envDir) {
    const wanted = await normalizedPath(envDir);
    for (const [id, profile] of Object.entries(registry.profiles)) {
      if (profile.tool === tool && (await normalizedPath(profile.configDir)) === wanted) return id;
    }
    return null;
  }

  return registry.activeProfiles[tool] ?? null;
}

function timestamp() {
  const now = new Date();
  const tz = getTimezoneOffset(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${tz}`;
  return { ts, tz };
}

async function trackClaude(profileId: string, configDir: string, usage: UsageStore) {
  const projects = await claudeProjects(configDir);
  if (!projects) return false;
  usage[profileId] ??= { records: [], seenSessions: {} };
  const profileUsage = usage[profileId];
  let seen = profileUsage.seenSessions;
  if (!seen) {
    seen = {};
    profileUsage.seenSessions = seen;
  }
  const { ts, tz } = timestamp();
  let changed = false;

  for (const [projPath, projData] of Object.entries(projects)) {
    if (!projData || typeof projData !== "object") continue;

    const fp = buildFingerprint(projData);
    if (!fp) continue;
    if (seen[projPath] === fp) continue;

    const cost = (projData.lastCost as number) ?? 0;
    const inputTokens = (projData.lastTotalInputTokens as number) ?? 0;
    const outputTokens = (projData.lastTotalOutputTokens as number) ?? 0;

    seen[projPath] = fp;
    profileUsage.records.push({
      ts,
      tz,
      cost: Math.round(cost * 1e6) / 1e6,
      inputTokens,
      outputTokens,
    });
    changed = true;
  }

  return changed;
}

async function trackCodex(profileId: string, configDir: string, usage: UsageStore) {
  const current = await readCodexSessionTotals(configDir);
  usage[profileId] ??= { records: [] };
  const profileUsage = usage[profileId];

  if (profileUsage.codexSessions === undefined) {
    profileUsage.codexSessions = current;
    return true;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let changed = false;

  for (const [sessionPath, totals] of Object.entries(current)) {
    const previous = profileUsage.codexSessions[sessionPath];
    if (previous && (totals.inputTokens < previous.inputTokens || totals.outputTokens < previous.outputTokens)) {
      profileUsage.codexSessions[sessionPath] = totals;
      changed = true;
      continue;
    }

    const inputDelta = totals.inputTokens - (previous?.inputTokens ?? 0);
    const outputDelta = totals.outputTokens - (previous?.outputTokens ?? 0);
    if (inputDelta > 0 || outputDelta > 0) {
      inputTokens += inputDelta;
      outputTokens += outputDelta;
    }
    if (!previous || totals.inputTokens !== previous.inputTokens || totals.outputTokens !== previous.outputTokens) {
      profileUsage.codexSessions[sessionPath] = totals;
      changed = true;
    }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    const { ts, tz } = timestamp();
    profileUsage.records.push({ ts, tz, cost: 0, inputTokens, outputTokens });
    changed = true;
  }

  return changed;
}

/**
 * Track usage for a qualified profile, tool, or the active Claude-first profile.
 */
export async function trackUsage(target?: string): Promise<void> {
  const registry = await readJson<Registry | null>(REGISTRY_PATH, null);
  if (!registry) return;
  const profileId = await resolveProfileId(registry, target);
  if (!profileId) return;
  const profile = registry.profiles[profileId];
  if (!profile?.configDir) return;

  const usage = await readJson<UsageStore>(USAGE_PATH, {});
  const changed =
    profile.tool === "codex"
      ? await trackCodex(profileId, profile.configDir, usage)
      : await trackClaude(profileId, profile.configDir, usage);
  if (changed) {
    await writeJson(USAGE_PATH, usage);
  }
}

function buildFingerprint(projData: Record<string, unknown>): string | null {
  const sid = (projData.lastSessionId as string) ?? "";
  const cost = (projData.lastCost as number) ?? 0;
  if (!sid || !cost || cost <= 0) return null;
  const inputTokens = (projData.lastTotalInputTokens as number) ?? 0;
  const outputTokens = (projData.lastTotalOutputTokens as number) ?? 0;
  const duration = (projData.lastDuration as number) ?? 0;
  return `${sid}:${cost}:${inputTokens}:${outputTokens}:${duration}`;
}

export async function seedProfileUsage(profileId: string, tool: ToolName, configDir: string): Promise<void> {
  const usage = await readJson<UsageStore>(USAGE_PATH, {});
  usage[profileId] ??= { records: [] };

  if (tool === "codex") {
    usage[profileId].codexSessions = await readCodexSessionTotals(configDir);
    await writeJson(USAGE_PATH, usage);
    return;
  }

  const projects = await claudeProjects(configDir);
  if (!projects) return;
  let seen = usage[profileId].seenSessions;
  if (!seen) {
    seen = {};
    usage[profileId].seenSessions = seen;
  }

  let changed = false;
  for (const [projPath, projData] of Object.entries(projects)) {
    if (!projData || typeof projData !== "object") continue;
    const fp = buildFingerprint(projData);
    if (!fp || seen[projPath]) continue;
    seen[projPath] = fp;
    changed = true;
  }

  if (changed) {
    await writeJson(USAGE_PATH, usage);
  }
}

export async function seedSeenSessions(profileName: string, configDir: string): Promise<void> {
  await seedProfileUsage(profileName, "claude", configDir);
}

function getTimezoneOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const h = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
  const m = String(Math.abs(offset) % 60).padStart(2, "0");
  return `${sign}${h}:${m}`;
}
