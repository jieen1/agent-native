/**
 * locale-kit/cli — offline extraction, completeness audit & catalog maintenance.
 *
 * Runnable with tsx (no Vite / dev-server needed):
 *
 *   tsx packages/locale-kit/src/cli/index.ts extract
 *   tsx packages/locale-kit/src/cli/index.ts audit --missing
 *   tsx packages/locale-kit/src/cli/index.ts audit --unwrapped
 *   tsx packages/locale-kit/src/cli/index.ts audit --missing --unwrapped
 *
 * `extract` globs the same in-scope source roots the Vite plugin processes,
 * runs each file through the SAME `transformModule` the plugin uses, and unions
 * every wrapped English key into `catalogs/en.json` (read-merge-write, sorted).
 *
 * `audit` runs the P9 completeness gates (see IMPLEMENTATION-PLAN §6 P9):
 *   --missing    every en.json key must have a non-empty zh.json translation.
 *   --unwrapped  AST-scan every in-scope file for user-facing strings the
 *                plugin's rules do NOT already wrap in t()/tx(); report
 *                residual candidates, suppressing reviewed false-positives via
 *                `i18n-unwrapped-allowlist.json` and inline `// i18n-ignore`.
 *
 * Any failing gate sets a non-zero exit code so the command can gate CI.
 *
 * Deterministic: a fixed in-scope file list, the shared pure transform, and a
 * sorted merge / sorted reporting.
 */

import fs from "node:fs";
import path from "node:path";
import { transformModule } from "../vite/transform.js";
import { CatalogWriter } from "../vite/catalog.js";
import {
  allInScopeFiles,
  collectSourceFiles,
  findRepoRoot,
  inScopeRoots,
} from "./scope.js";
import { findMissingTranslations } from "./missing.js";
import { scanFileForUnwrapped, type UnwrappedCandidate } from "./unwrapped.js";
import { loadAllowlist } from "./allowlist.js";

interface ExtractResult {
  filesScanned: number;
  totalKeys: number;
  newKeys: number;
}

function catalogPath(repoRoot: string, name: "en" | "zh"): string {
  return path.join(
    repoRoot,
    "packages",
    "locale-kit",
    "src",
    "catalogs",
    `${name}.json`,
  );
}

function allowlistPath(repoRoot: string): string {
  return path.join(
    repoRoot,
    "packages",
    "locale-kit",
    "i18n-unwrapped-allowlist.json",
  );
}

/**
 * Run extraction: transform every in-scope file, union the wrapped keys, and
 * merge them into `en.json` via the shared CatalogWriter (sorted, additive).
 */
function runExtract(repoRoot: string): ExtractResult {
  const enPath = catalogPath(repoRoot, "en");
  const existingBefore = readCatalogKeys(enPath);

  const union = new Set<string>();
  let filesScanned = 0;

  for (const root of inScopeRoots(repoRoot)) {
    for (const file of collectSourceFiles(root)) {
      filesScanned++;
      const code = fs.readFileSync(file, "utf-8");
      const normalized = file.replace(/\\/g, "/");
      let result;
      try {
        result = transformModule(code, normalized);
      } catch {
        continue;
      }
      if (!result) continue;
      for (const key of result.keys) union.add(key);
    }
  }

  const writer = new CatalogWriter(enPath);
  writer.add(union);
  writer.flush();

  return {
    filesScanned,
    totalKeys: union.size,
    newKeys: countNewKeys(union, existingBefore),
  };
}

/** Read the set of existing catalog keys, tolerating a missing/invalid file. */
function readCatalogKeys(enPath: string): Set<string> {
  try {
    const raw = fs.readFileSync(enPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return new Set(Object.keys(parsed as Record<string, string>));
    }
  } catch {
    // Missing or malformed — treat as empty.
  }
  return new Set();
}

/** Count keys in `union` that were not already present in the catalog. */
function countNewKeys(union: Set<string>, existing: Set<string>): number {
  let count = 0;
  for (const key of union) {
    if (!existing.has(key)) count++;
  }
  return count;
}

/** Lines (1-based) in `code` that carry a `// i18n-ignore` marker. */
function ignoredLines(code: string): Set<number> {
  const out = new Set<number>();
  const lines = code.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes("i18n-ignore")) out.add(index + 1);
  });
  return out;
}

interface UnwrappedReport {
  filesScanned: number;
  total: number;
  suppressed: number;
  unsuppressed: UnwrappedCandidate[];
}

/**
 * Run the unwrapped-text audit across every in-scope file. Per file: scan for
 * residual user-facing strings, drop any whose source line carries an inline
 * `// i18n-ignore`, then split the rest into allowlist-suppressed vs
 * unsuppressed. Unsuppressed candidates are sorted (file, then line) and are
 * what gates CI.
 */
function runUnwrapped(repoRoot: string): UnwrappedReport {
  const allowlist = loadAllowlist(allowlistPath(repoRoot));
  const repoPrefix = repoRoot.replace(/\\/g, "/");

  let filesScanned = 0;
  let total = 0;
  let suppressed = 0;
  const unsuppressed: UnwrappedCandidate[] = [];

  for (const file of allInScopeFiles(repoRoot)) {
    filesScanned++;
    const code = fs.readFileSync(file, "utf-8");
    const normalized = file.replace(/\\/g, "/");
    // Report file paths repo-relative for stable, worktree-independent output.
    const relative = normalized.startsWith(`${repoPrefix}/`)
      ? normalized.slice(repoPrefix.length + 1)
      : normalized;

    let candidates: UnwrappedCandidate[];
    try {
      candidates = scanFileForUnwrapped(code, normalized);
    } catch {
      continue;
    }
    if (candidates.length === 0) continue;

    const ignored = ignoredLines(code);
    for (const candidate of candidates) {
      // Inline `// i18n-ignore` on the candidate's line exempts it entirely
      // (not counted as suppressed-by-allowlist, just skipped).
      if (ignored.has(candidate.line)) continue;
      total++;
      const display: UnwrappedCandidate = { ...candidate, file: relative };
      if (allowlist.suppresses(relative, candidate.text)) {
        suppressed++;
        continue;
      }
      unsuppressed.push(display);
    }
  }

  unsuppressed.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );

  return { filesScanned, total, suppressed, unsuppressed };
}

const MAX_MISSING_PRINTED = 30;
const MAX_UNWRAPPED_PRINTED = 50;

/** Run the requested audit gates and return a process exit code. */
function runAudit(repoRoot: string, flags: Set<string>): number {
  // Default to running both gates when neither flag is given.
  const doMissing = flags.has("--missing") || flags.size === 0;
  const doUnwrapped = flags.has("--unwrapped") || flags.size === 0;
  let exitCode = 0;
  const out = process.stdout;

  if (doMissing) {
    const result = findMissingTranslations(
      catalogPath(repoRoot, "en"),
      catalogPath(repoRoot, "zh"),
    );
    out.write(`\nlocale-kit audit --missing\n`);
    out.write(`  en keys:        ${result.totalKeys}\n`);
    out.write(`  missing in zh:  ${result.missing.length}\n`);
    if (result.missing.length > 0) {
      out.write(
        `  first ${Math.min(result.missing.length, MAX_MISSING_PRINTED)} missing keys:\n`,
      );
      for (const key of result.missing.slice(0, MAX_MISSING_PRINTED)) {
        out.write(`    - ${JSON.stringify(key)}\n`);
      }
      exitCode = 1;
    } else {
      out.write(`  OK — every en key has a non-empty zh translation.\n`);
    }
  }

  if (doUnwrapped) {
    const report = runUnwrapped(repoRoot);
    out.write(`\nlocale-kit audit --unwrapped\n`);
    out.write(`  files scanned:        ${report.filesScanned}\n`);
    out.write(`  candidates found:     ${report.total}\n`);
    out.write(`  allowlist-suppressed: ${report.suppressed}\n`);
    out.write(`  unsuppressed:         ${report.unsuppressed.length}\n`);
    if (report.unsuppressed.length > 0) {
      const shown = report.unsuppressed.slice(0, MAX_UNWRAPPED_PRINTED);
      out.write(
        `  first ${shown.length} unsuppressed candidate(s) [file:line — reason — string]:\n`,
      );
      for (const c of shown) {
        out.write(
          `    ${c.file}:${c.line} — ${c.reason} — ${JSON.stringify(c.text)}\n`,
        );
      }
      if (report.unsuppressed.length > shown.length) {
        out.write(
          `    … and ${report.unsuppressed.length - shown.length} more.\n`,
        );
      }
      out.write(
        `  Suppress reviewed false-positives in packages/locale-kit/i18n-unwrapped-allowlist.json` +
          ` or with an inline // i18n-ignore comment.\n`,
      );
      exitCode = 1;
    } else {
      out.write(`  OK — no unsuppressed unwrapped user-facing strings.\n`);
    }
  }

  return exitCode;
}

function main(argv: string[]): void {
  const command = argv[2];
  const repoRoot = findRepoRoot();

  if (command === "extract") {
    const result = runExtract(repoRoot);
    process.stdout.write(
      `locale-kit extract\n` +
        `  files scanned: ${result.filesScanned}\n` +
        `  total keys:    ${result.totalKeys}\n` +
        `  new keys added: ${result.newKeys}\n`,
    );
    return;
  }

  if (command === "audit") {
    const flags = new Set(argv.slice(3).filter((a) => a.startsWith("--")));
    const known = new Set(["--missing", "--unwrapped"]);
    for (const flag of flags) {
      if (!known.has(flag)) {
        process.stderr.write(`Unknown audit flag: ${flag}\n`);
        process.exitCode = 2;
        return;
      }
    }
    process.exitCode = runAudit(repoRoot, flags);
    return;
  }

  process.stderr.write(
    `Unknown command: ${command ?? "(none)"}\n` +
      `Usage:\n` +
      `  tsx packages/locale-kit/src/cli/index.ts extract\n` +
      `  tsx packages/locale-kit/src/cli/index.ts audit [--missing] [--unwrapped]\n`,
  );
  process.exitCode = 1;
}

main(process.argv);
