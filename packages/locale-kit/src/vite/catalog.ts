/**
 * In-memory key accumulator with a safe read-merge-write persistence to the
 * `en` catalog. The English source string is both key and value; existing keys
 * (including hand-authored translations elsewhere) are never dropped.
 */

import fs from "node:fs";
import path from "node:path";

/** Stable, deterministic JSON: keys sorted, two-space indent, trailing newline. */
function serialize(entries: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(entries).sort()) {
    sorted[key] = entries[key]!;
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

export class CatalogWriter {
  private readonly enPath: string;
  private readonly keys = new Set<string>();

  constructor(enPath: string) {
    this.enPath = enPath;
  }

  /** Record newly wrapped English source keys. */
  add(newKeys: Iterable<string>): void {
    for (const key of newKeys) this.keys.add(key);
  }

  /**
   * Merge accumulated keys into the on-disk catalog. Reads the current file,
   * adds any missing `{key: key}` entries, and rewrites sorted JSON only when
   * something actually changed. Concurrent transforms re-read each time so no
   * keys are lost.
   */
  flush(): void {
    if (this.keys.size === 0) return;

    let existing: Record<string, string> = {};
    try {
      const raw = fs.readFileSync(this.enPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, string>;
      }
    } catch {
      // Missing or malformed catalog — start from an empty object.
    }

    let changed = false;
    const merged: Record<string, string> = { ...existing };
    for (const key of this.keys) {
      if (!(key in merged)) {
        merged[key] = key;
        changed = true;
      }
    }
    if (!changed) return;

    fs.mkdirSync(path.dirname(this.enPath), { recursive: true });
    fs.writeFileSync(this.enPath, serialize(merged), "utf-8");
  }
}
