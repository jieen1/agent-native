/**
 * Deterministic markdown parsing helpers for the `sprint-doc` artifact
 * (`/sprint-plan` skill output), used by `check-artifact-gates`. Zero LLM —
 * same regex-locate-a-heading-then-parse-its-lines shape as
 * `extract-goal-metrics.ts`'s `extractSuccessMetricsSection` (this module
 * deliberately does not duplicate that one — reuse it directly for the
 * Success Metrics / M-number check).
 *
 * Convention this module assumes (authored by `/sprint-plan`'s SKILL.md):
 *
 *   ## In-Scope
 *   - O1: {outcome statement}
 *   - O2: {outcome statement}
 *
 *   ## Out-of-Scope
 *   - {statement}
 */

const HEADING_RE = /^#{1,6}\s/;
const IN_SCOPE_RE = /^in-scope$/i;
const OUT_OF_SCOPE_RE = /^(out-of-scope|out of scope)$/i;
const OUTCOME_RE = /^[-*]\s*(O\d+)\s*[:：]\s*(.+)$/;

function extractHeadingSection(
  content: string,
  headingMatch: (h: string) => boolean,
): string[] | null {
  const lines = content.split("\n");
  let start: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (
      HEADING_RE.test(trimmed) &&
      headingMatch(trimmed.replace(/^#+\s*/, "").trim())
    ) {
      start = i;
      break;
    }
  }
  if (start === undefined) return null;

  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (HEADING_RE.test(trimmed)) break;
    section.push(trimmed);
  }
  return section;
}

export interface InScopeOutcome {
  id: string;
  statement: string;
}

/** Parse `## In-Scope` bullets of the form `- O1: statement` into stable-id outcomes. */
export function parseInScopeOutcomes(content: string): InScopeOutcome[] {
  const section = extractHeadingSection(content, (h) => IN_SCOPE_RE.test(h));
  if (section === null) return [];
  const outcomes: InScopeOutcome[] = [];
  for (const line of section) {
    if (!line) continue;
    const m = OUTCOME_RE.exec(line);
    if (m) outcomes.push({ id: m[1]!, statement: m[2]!.trim() });
  }
  return outcomes;
}

/** Non-empty `## Out-of-Scope` bullet lines (trimmed, blanks dropped). */
export function parseOutOfScope(content: string): string[] {
  const section = extractHeadingSection(content, (h) =>
    OUT_OF_SCOPE_RE.test(h),
  );
  if (section === null) return [];
  return section
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l.length > 0);
}

const FENCED_CODE_RE = /```[\s\S]*?```/g;
const PATH_LIKE_RE =
  /`?\b[\w.-]+(?:\/[\w.-]+)+\.(?:tsx?|jsx?|mjs|cjs|sql|json|md|css|scss|py|go|rs|vue|ya?ml)\b`?/g;

export interface DocHygieneViolation {
  kind: "code-block" | "file-path";
  snippet: string;
}

/**
 * Scan for fenced code blocks or file-path-looking tokens anywhere in the
 * document — `sprint-doc` must read as prose, not implementation ("全文无
 * 文件路径/代码块", r4-workflow-families-planning-skills.md §5.2). Heuristic
 * (regex, not an AST), same honesty caveat as scale-estimate.ts's own
 * path-detection regex.
 */
export function findDocHygieneViolations(
  content: string,
): DocHygieneViolation[] {
  const violations: DocHygieneViolation[] = [];
  for (const m of content.matchAll(FENCED_CODE_RE)) {
    violations.push({ kind: "code-block", snippet: m[0].slice(0, 60) });
  }
  const withoutFences = content.replace(FENCED_CODE_RE, "");
  for (const m of withoutFences.matchAll(PATH_LIKE_RE)) {
    violations.push({ kind: "file-path", snippet: m[0] });
  }
  return violations;
}
