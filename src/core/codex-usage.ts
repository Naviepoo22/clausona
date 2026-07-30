import { open, readdir } from "node:fs/promises";
import path from "node:path";

export type CodexTokenTotals = {
  inputTokens: number;
  outputTokens: number;
};

const INITIAL_TAIL_BYTES = 64 * 1024;

function parseTokenTotals(line: string): CodexTokenTotals | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  if (!event || typeof event !== "object") return null;
  const record = event as {
    type?: unknown;
    payload?: {
      type?: unknown;
      info?: {
        total_token_usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
        };
      } | null;
    };
  };
  if (record.type !== "event_msg" || record.payload?.type !== "token_count") return null;

  const inputTokens = record.payload.info?.total_token_usage?.input_tokens;
  const outputTokens = record.payload.info?.total_token_usage?.output_tokens;
  if (
    typeof inputTokens !== "number" ||
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0
  ) {
    return null;
  }

  return { inputTokens, outputTokens };
}

export async function readLatestCodexTokenTotals(filePath: string): Promise<CodexTokenTotals | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    let tailBytes = Math.min(size, INITIAL_TAIL_BYTES);

    while (tailBytes > 0) {
      const start = size - tailBytes;
      const buffer = Buffer.alloc(tailBytes);
      const { bytesRead } = await handle.read(buffer, 0, tailBytes, start);
      let text = buffer.subarray(0, bytesRead).toString("utf8");

      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
      }

      const lines = text.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const totals = parseTokenTotals(lines[index]);
        if (totals) return totals;
      }

      if (start === 0) return null;
      tailBytes = Math.min(size, tailBytes * 2);
    }

    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function findSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

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
  const sessionRoot = path.join(configDir, "sessions");
  const files = await findSessionFiles(sessionRoot);
  const totals: Record<string, CodexTokenTotals> = {};

  await Promise.all(
    files.map(async (filePath) => {
      const latest = await readLatestCodexTokenTotals(filePath);
      if (!latest) return;
      const relativePath = path.relative(sessionRoot, filePath).split(path.sep).join("/");
      totals[relativePath] = latest;
    }),
  );

  return totals;
}
