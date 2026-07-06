// Shared, non-registered helper for the Skills / Runbook editor (list-skills,
// get-skill, save-skill, revert-skill). Filename is prefixed with `_` so the
// action-discovery loader (packages/core/src/server/action-discovery.ts)
// skips it — it is not itself an action.
//
// Reads `.agents/skills/*/SKILL.md` straight off disk, the same way
// `server/agent-loader.ts` reads `.claude/agents/*.md`: a plain, hand-rolled
// fs read with a dev/built-bundle candidate directory list, NOT the generic
// `@agent-native/core/local-artifacts` local-workspace-resource helpers.
// Those helpers gate every read behind `isLocalWorkspaceResourcesEnabled()`
// (true only when this deployment's `agent-native.json`/`AGENT_NATIVE_MODE`
// says "local-files"), which is correct for a Content/Plans/Slides-style
// artifact app but wrong here — the Skills page must be BROWSABLE in the
// default "database" mode too (that's the common hosted case), and the real
// `.agents/skills/*/SKILL.md` files are still shipped in the container
// either way. So: reads always hit the real file (informational, read-only,
// not a durability concern); only the WRITE path in save-skill branches on
// `isLocalWorkspaceResourcesEnabled()` to decide file vs. SQL override.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirrors agent-loader.ts's AGENTS_DIR_CANDIDATES: in a built bundle
// `__dirname` resolves into `.output/server/`, so `.agents/skills` is not
// next to it — prefer the app's working dir (the template root, where the
// skills live and are mounted at runtime), then fall back to source-relative
// paths for dev/tests.
const SKILLS_DIR_CANDIDATES = [
  join(process.cwd(), ".agents", "skills"),
  join(__dirname, "..", ".agents", "skills"),
  join(__dirname, "..", "..", ".agents", "skills"),
];

function skillsDir(): string {
  return (
    SKILLS_DIR_CANDIDATES.find((d) => existsSync(d)) ?? SKILLS_DIR_CANDIDATES[0]
  );
}

/** Sentinel `path` for the orchestrator brain's own runbook (BRAIN_PROMPT in
 * server/brain/brain-session.ts) — a hardcoded string constant, not a file
 * under `.agents/skills/`, so it always goes through the SQL override table
 * (never the Local File Mode file-write branch). Deliberately has no
 * "skills/" prefix and no "/SKILL.md" suffix so it can never collide with a
 * real skill path. */
export const BRAIN_RUNBOOK_PATH = "brain-runbook";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  category?: string;
  hasSource?: boolean;
}

/**
 * Minimal frontmatter reader — just enough for the fields this feature
 * displays (name/description/category), not a general YAML parser. Handles
 * the one multi-line shape every SKILL.md in this repo actually uses:
 * `description: >-` followed by indented continuation lines (YAML folded
 * block scalar). Nested blocks like `metadata:\n  internal: true` are
 * harmlessly skipped (the indented line just never matches the key regex).
 */
function parseSkillFrontmatter(raw: string): {
  meta: SkillFrontmatter;
  frontmatterRaw: string;
} {
  const match = raw.match(/^---[ \t]*\r?\n([\s\S]*?\r?\n)---[ \t]*\r?\n?/);
  if (!match) return { meta: {}, frontmatterRaw: "" };
  const frontmatterRaw = match[0];
  const lines = match[1].split(/\r?\n/);
  const meta: SkillFrontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const keyMatch = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[1]!;
    let value = keyMatch[2]!.trim();
    i++;
    if (value === ">-" || value === ">" || value === "|-" || value === "|") {
      const collected: string[] = [];
      while (i < lines.length && /^[ \t]+\S/.test(lines[i]!)) {
        collected.push(lines[i]!.trim());
        i++;
      }
      value = collected.join(value.startsWith("|") ? "\n" : " ").trim();
    } else {
      value = value.replace(/^["'](.*)["']$/, "$1");
    }
    if (key === "name") meta.name = value;
    else if (key === "description") meta.description = value;
    else if (key === "category") meta.category = value;
    else if (key === "source") meta.hasSource = true;
  }
  return { meta, frontmatterRaw };
}

/** "adding-a-feature" -> "Adding A Feature" */
export function prettifySkillName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

export interface SkillFileSummary {
  path: string;
  name: string;
  title: string;
  description: string;
  category: string;
  updatedAt: string;
}

export interface SkillFileDetail extends SkillFileSummary {
  /** Everything after the frontmatter fence — the editable prose body. */
  body: string;
  /** The original frontmatter fence, verbatim, preserved on save (this
   * editor only edits the body, matching the approved design's split editor
   * which shows body-only markdown, not the YAML metadata block). */
  frontmatterRaw: string;
}

/** `path` must be exactly `skills/<dirName>/SKILL.md`. Throws on anything
 * else — this is the single validation gate get-skill/save-skill/revert-skill
 * run untrusted client input through before touching the filesystem. */
export function resolveSkillDirName(path: string): string {
  const match = /^skills\/([A-Za-z0-9._-]+)\/SKILL\.md$/.exec(path);
  if (!match || match[1] === "." || match[1] === "..") {
    throw new Error(`Invalid skill path "${path}"`);
  }
  return match[1]!;
}

function skillFileAbsolutePath(dirName: string): string {
  return join(skillsDir(), dirName, "SKILL.md");
}

/** Reads one skill file by its `skills/<name>/SKILL.md` path. Returns null
 * if the path is well-formed but the file does not exist on disk. */
export function readSkillFile(path: string): SkillFileDetail | null {
  const dirName = resolveSkillDirName(path);
  const abs = skillFileAbsolutePath(dirName);
  if (!existsSync(abs)) return null;
  const raw = readFileSync(abs, "utf8");
  const stat = statSync(abs);
  const { meta, frontmatterRaw } = parseSkillFrontmatter(raw);
  const name = meta.name || dirName;
  return {
    path,
    name,
    title: prettifySkillName(name),
    description: meta.description ?? "",
    category: meta.category || (meta.hasSource ? "External" : "General"),
    updatedAt: stat.mtime.toISOString(),
    body: raw.slice(frontmatterRaw.length),
    frontmatterRaw,
  };
}

/** Lists every `.agents/skills/<name>/SKILL.md` in this template, sorted by
 * title. Skips directories with no `SKILL.md` (e.g. a skill's `references/`
 * companion folder is not itself walked — this editor targets each skill's
 * primary instructions file, not its ancillary assets). */
export function listSkillFiles(): SkillFileSummary[] {
  const root = skillsDir();
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  );
  const out: SkillFileSummary[] = [];
  for (const entry of entries) {
    const path = `skills/${entry.name}/SKILL.md`;
    const detail = readSkillFile(path);
    if (!detail) continue;
    out.push({
      path: detail.path,
      name: detail.name,
      title: detail.title,
      description: detail.description,
      category: detail.category,
      updatedAt: detail.updatedAt,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Re-assembles a full SKILL.md file from its (unedited) original
 * frontmatter fence plus a new body, for the Local File Mode write path. */
export function rebuildSkillFileContent(
  frontmatterRaw: string,
  body: string,
): string {
  return `${frontmatterRaw}${body}`;
}
