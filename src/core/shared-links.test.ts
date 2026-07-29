import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createSharedLink, inspectSharedLink } from "./shared-links.js";

describe("Windows shared links", () => {
  it.runIf(process.platform === "win32")("uses an unprivileged junction for directories", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clausona-junction-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    mkdirSync(source);
    writeFileSync(path.join(source, "marker.txt"), "shared");

    try {
      await createSharedLink(source, target, { platform: "win32", isDirectory: true });

      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readFileSync(path.join(target, "marker.txt"), "utf8")).toBe("shared");
      expect(await inspectSharedLink(target, source)).toMatchObject({
        isSharedLink: true,
        pointsToSource: true,
        targetExists: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "win32")("falls back to a hard link for files without symlink privilege", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "clausona-hardlink-"));
    const source = path.join(root, "source.json");
    const target = path.join(root, "target.json");
    writeFileSync(source, "shared");

    try {
      await createSharedLink(source, target, { platform: "win32", isDirectory: false });

      expect(readFileSync(target, "utf8")).toBe("shared");
      expect(await inspectSharedLink(target, source)).toMatchObject({
        isSharedLink: true,
        pointsToSource: true,
        targetExists: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
