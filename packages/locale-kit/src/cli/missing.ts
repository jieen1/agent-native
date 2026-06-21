/**
 * `audit --missing` core: every key in `catalogs/en.json` must be present AND
 * non-empty in `catalogs/zh.json`. A key whose zh value is missing, an empty
 * string, or whitespace-only counts as missing — an untranslated string would
 * otherwise silently fall back to English at runtime.
 */

import fs from "node:fs";

export interface MissingResult {
  /** Total keys in en.json. */
  totalKeys: number;
  /** Keys missing or empty in zh.json. */
  missing: string[];
}

/** Read a catalog file as a string map, tolerating absence (empty map). */
function readCatalog(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Missing or malformed — treat as empty.
  }
  return {};
}

/** A zh value counts as present only if it is a non-empty, non-whitespace string. */
function isPresent(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Compute which en keys lack a non-empty zh translation. Missing keys are
 * returned sorted for stable output.
 */
export function findMissingTranslations(
  enPath: string,
  zhPath: string,
): MissingResult {
  const en = readCatalog(enPath);
  const zh = readCatalog(zhPath);

  const missing: string[] = [];
  for (const key of Object.keys(en)) {
    if (!isPresent(zh[key])) missing.push(key);
  }
  missing.sort();

  return { totalKeys: Object.keys(en).length, missing };
}
