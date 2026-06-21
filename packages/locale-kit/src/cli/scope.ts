/**
 * Shared in-scope source discovery for the locale-kit CLI.
 *
 * `extract` and `audit --unwrapped` MUST scan the SAME roots: the shared core
 * client chrome, the core SERVER-side i18n surfaces the Vite plugin's
 * ALWAYS_INCLUDE set wraps, and each template's app / components / actions plus
 * its login-marketing auth plugin. Keeping the roots and the file walk in one
 * module guarantees the audit gate covers exactly what extraction (and the
 * runtime plugin) processes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the monorepo root by walking up from this module until a directory
 * containing both `packages/` and `templates/` is found.
 */
export function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, "packages")) &&
      fs.existsSync(path.join(dir, "templates"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: four levels up (src/cli -> src -> locale-kit -> packages -> root).
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
  );
}

const PROCESS_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js"]);

/** Whether a POSIX-normalized path is an excluded test / declaration / vendor file. */
export function isExcluded(posixPath: string): boolean {
  if (posixPath.includes("/node_modules/")) return true;
  if (posixPath.endsWith(".d.ts")) return true;
  if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(posixPath)) return true;
  return false;
}

/**
 * Recursively collect every processable source file under `root`. A `root` may
 * be a directory (walked recursively) OR a single source file (included
 * directly). Returns absolute paths sorted for deterministic ordering. Missing
 * roots yield an empty list.
 */
export function collectSourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return [];
  }
  if (rootStat.isFile()) {
    const posix = root.replace(/\\/g, "/");
    if (!PROCESS_EXTENSIONS.has(path.extname(root))) return [];
    if (isExcluded(posix)) return [];
    return [root];
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const posix = full.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!PROCESS_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (isExcluded(posix)) continue;
      out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/** The 15 public templates whose UI + actions are in extraction/audit scope. */
export const TEMPLATES = [
  "chat",
  "calendar",
  "content",
  "plan",
  "slides",
  "videos",
  "clips",
  "brain",
  "analytics",
  "mail",
  "dispatch",
  "forms",
  "design",
  "assets",
  "macros",
];

/**
 * Build the ordered list of in-scope roots: the shared core client chrome, the
 * core SERVER-side i18n surfaces the Vite plugin's ALWAYS_INCLUDE set wraps,
 * each template's app / components / actions directories, and each template's
 * login-marketing auth plugin. Mirrors the union of every template's runtime
 * plugin `include` plus the always-on core set, so the audit sees exactly what
 * the runtime plugin wraps.
 */
export function inScopeRoots(repoRoot: string): string[] {
  const coreSrc = (...segments: string[]): string =>
    path.join(repoRoot, "packages", "core", "src", ...segments);

  const roots = [
    coreSrc("client"),
    coreSrc("onboarding"),
    coreSrc("server", "email-templates.ts"),
    coreSrc("server", "email-template.ts"),
    coreSrc("server", "auth-marketing.ts"),
    coreSrc("notifications"),
  ];
  for (const template of TEMPLATES) {
    for (const sub of ["app", "components", "actions"]) {
      roots.push(path.join(repoRoot, "templates", template, sub));
    }
    roots.push(
      path.join(
        repoRoot,
        "templates",
        template,
        "server",
        "plugins",
        "auth.ts",
      ),
    );
  }
  return roots;
}

/** Every in-scope source file across all roots (sorted, deduped). */
export function allInScopeFiles(repoRoot: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of inScopeRoots(repoRoot)) {
    for (const file of collectSourceFiles(root)) {
      if (seen.has(file)) continue;
      seen.add(file);
      out.push(file);
    }
  }
  return out;
}
