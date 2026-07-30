import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CodexRateLimits, CodexRateLimitWindow } from "../types.js";

export type CodexTokenTotals = {
  inputTokens: number;
  outputTokens: number;
};

const INITIAL_TAIL_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

type CodexSessionUsage = {
  totals?: CodexTokenTotals;
  rateLimits?: CodexRateLimits;
};

function parseRateLimitWindow(value: unknown): CodexRateLimitWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const window = value as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
  if (
    typeof window.used_percent !== "number" ||
    !Number.isFinite(window.used_percent) ||
    window.used_percent < 0 ||
    window.used_percent > 100 ||
    typeof window.window_minutes !== "number" ||
    !Number.isFinite(window.window_minutes) ||
    window.window_minutes <= 0 ||
    typeof window.resets_at !== "number" ||
    !Number.isFinite(window.resets_at) ||
    window.resets_at <= 0
  ) {
    return undefined;
  }
  return {
    usedPercent: window.used_percent,
    windowMinutes: window.window_minutes,
    resetsAt: window.resets_at,
  };
}

function parseSessionUsage(line: string): CodexSessionUsage | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  if (!event || typeof event !== "object") return null;
  const record = event as {
    timestamp?: unknown;
    type?: unknown;
    payload?: {
      type?: unknown;
      info?: {
        total_token_usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
        };
      } | null;
      rate_limits?: {
        plan_type?: unknown;
        primary?: unknown;
        secondary?: unknown;
      } | null;
    };
  };
  if (record.type !== "event_msg" || record.payload?.type !== "token_count") return null;

  const inputTokens = record.payload.info?.total_token_usage?.input_tokens;
  const outputTokens = record.payload.info?.total_token_usage?.output_tokens;
  const totals =
    typeof inputTokens === "number" &&
    Number.isFinite(inputTokens) &&
    inputTokens >= 0 &&
    typeof outputTokens === "number" &&
    Number.isFinite(outputTokens) &&
    outputTokens >= 0
      ? { inputTokens, outputTokens }
      : undefined;

  const primary = parseRateLimitWindow(record.payload.rate_limits?.primary);
  const secondary = parseRateLimitWindow(record.payload.rate_limits?.secondary);
  const observedAt =
    typeof record.timestamp === "string" &&
    Number.isFinite(Date.parse(record.timestamp)) &&
    Date.parse(record.timestamp) <= Date.now() + MAX_CLOCK_SKEW_MS
      ? record.timestamp
      : undefined;
  const planType =
    typeof record.payload.rate_limits?.plan_type === "string" && record.payload.rate_limits.plan_type
      ? record.payload.rate_limits.plan_type
      : undefined;
  const rateLimits =
    observedAt && (primary || secondary)
      ? {
          observedAt,
          ...(planType ? { planType } : {}),
          ...(primary ? { primary } : {}),
          ...(secondary ? { secondary } : {}),
        }
      : undefined;

  if (!totals && !rateLimits) {
    return null;
  }

  return { totals, rateLimits };
}

async function readLatestCodexSessionUsage(
  filePath: string,
  includeRateLimits: boolean,
): Promise<CodexSessionUsage | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    let tailBytes = Math.min(size, INITIAL_TAIL_BYTES);
    const latest: CodexSessionUsage = {};

    while (tailBytes > 0) {
      const start = size - tailBytes;
      const buffer = new Uint8Array(tailBytes);
      const { bytesRead } = await handle.read(buffer, 0, tailBytes, start);
      let text = new TextDecoder().decode(buffer.subarray(0, bytesRead));

      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
      }

      const lines = text.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const parsed = parseSessionUsage(lines[index]);
        if (!parsed) continue;
        latest.totals ??= parsed.totals;
        if (includeRateLimits) latest.rateLimits ??= parsed.rateLimits;
        if (latest.totals && (!includeRateLimits || latest.rateLimits)) return latest;
      }

      if (start === 0) return latest.totals || latest.rateLimits ? latest : null;
      tailBytes = Math.min(size, tailBytes * 2);
    }

    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readLatestCodexTokenTotals(filePath: string): Promise<CodexTokenTotals | null> {
  return (await readLatestCodexSessionUsage(filePath, false))?.totals ?? null;
}

async function findSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isSymbolicLink()) return;
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(entryPath);
        }
      }),
    );
  }

  await visit(root);
  return files;
}

export async function readCodexSessionTotals(configDir: string): Promise<Record<string, CodexTokenTotals>> {
  return (await readCodexSessionUsage(configDir)).sessions;
}

export async function readCodexSessionUsage(
  configDir: string,
): Promise<{ sessions: Record<string, CodexTokenTotals>; rateLimits?: CodexRateLimits }> {
  const sessionRoot = path.join(configDir, "sessions");
  const files = await findSessionFiles(sessionRoot);
  const sessions: Record<string, CodexTokenTotals> = {};
  const filesByRecency = (
    await Promise.all(
      files.map(async (filePath) => ({
        filePath,
        mtimeMs: await stat(filePath)
          .then((value) => value.mtimeMs)
          .catch(() => Number.NEGATIVE_INFINITY),
      })),
    )
  ).sort((a, b) => b.mtimeMs - a.mtimeMs || b.filePath.localeCompare(a.filePath));
  const newestFile = filesByRecency[0]?.filePath;

  const snapshots = await Promise.all(
    files.map(async (filePath) => {
      let latest: CodexSessionUsage | null;
      if (filePath === newestFile) {
        latest = await readLatestCodexSessionUsage(filePath, true);
      } else {
        const totals = await readLatestCodexTokenTotals(filePath);
        latest = totals ? { totals } : null;
      }
      if (!latest) return null;
      const relativePath = path.relative(sessionRoot, filePath).split(path.sep).join("/");
      return { relativePath, latest, isNewest: filePath === newestFile };
    }),
  );

  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    if (snapshot.latest.totals) sessions[snapshot.relativePath] = snapshot.latest.totals;
  }

  const rateLimits = snapshots.find((snapshot) => snapshot?.isNewest)?.latest.rateLimits;
  return { sessions, ...(rateLimits ? { rateLimits } : {}) };
}
