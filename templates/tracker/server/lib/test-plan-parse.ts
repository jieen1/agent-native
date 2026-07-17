/**
 * Deterministic markdown parsing helpers for the `test-plan` artifact
 * (`/sprint-test-plan` skill output). Used by `check-artifact-gates` and by
 * `extract-briefs` (to inject the relevant scenario section into
 * `sdlc-verify`-bound briefs per §5.5's payload allow-list).
 *
 * Convention this module assumes (authored by `/sprint-test-plan`'s
 * SKILL.md):
 *
 *   ## 场景
 *
 *   ### 场景 1 · 登录失败重试
 *   - **Why**: ...
 *   - **Steps**: ...
 *   - **Expected**: ...
 *   - **Pass-fail 信号**: ...
 *   - **执行工具**: ...
 *   - **关联指标**: M1, M2
 */

const H2_RE = /^##\s+(.+?)\s*$/;
const H3_SCENARIO_RE = /^###\s+场景\s*(\d+)\s*[·:]\s*(.+?)\s*$/;
const FIELD_RE = /^[-*]\s*\*\*(.+?)\*\*\s*[:：]\s*(.+)$/;
const CODE_SPAN_RE = /`[^`]+`/;

function extractH2Section(content: string, title: string): string | null {
  const lines = content.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = H2_RE.exec(lines[i]!.trim());
    if (m && m[1]!.trim() === title) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (H2_RE.test(lines[i]!.trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

export interface TestPlanScenario {
  id: string;
  title: string;
  fields: Record<string, string>;
  /** M-number ids from `**关联指标**` ("无" → empty). */
  metricRefs: string[];
  /** Raw body text (for black-box / code-span scanning). */
  body: string;
}

/** Parse every `### 场景 N · {标题}` card under `## 场景`. */
export function parseScenarios(content: string): TestPlanScenario[] {
  const section = extractH2Section(content, "场景");
  if (section === null) return [];
  const lines = section.split("\n");
  const boundaries: Array<{ idx: number; id: string; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = H3_SCENARIO_RE.exec(lines[i]!.trim());
    if (m) boundaries.push({ idx: i, id: `场景${m[1]}`, title: m[2]! });
  }

  const scenarios: TestPlanScenario[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const cur = boundaries[i]!;
    const next = boundaries[i + 1];
    const bodyLines = lines.slice(cur.idx + 1, next ? next.idx : lines.length);
    const body = bodyLines.join("\n").trim();
    const fields: Record<string, string> = {};
    let metricRefs: string[] = [];
    for (const raw of bodyLines) {
      const m = FIELD_RE.exec(raw.trim());
      if (!m) continue;
      const key = m[1]!.trim();
      const value = m[2]!.trim();
      fields[key] = value;
      if (key === "关联指标") {
        metricRefs = /^(无|none)$/i.test(value)
          ? []
          : value
              .split(/[,，、]/)
              .map((s) => s.trim())
              .filter(Boolean);
      }
    }
    scenarios.push({ id: cur.id, title: cur.title, fields, metricRefs, body });
  }
  return scenarios;
}

/** True when a scenario's body leaks internal symbol names (code spans) —
 *  violates the "黑盒（无内部符号名）" requirement. Heuristic. */
export function hasInternalSymbolLeak(scenario: TestPlanScenario): boolean {
  return CODE_SPAN_RE.test(scenario.body);
}

/** The `## 无集成场景声明` heading's body text, when the sprint has no
 *  cross-module scenarios to author ("无跨模块时一段式声明" per §5.2). Null
 *  when absent or blank. */
export function parseNoIntegrationDeclaration(content: string): string | null {
  const section = extractH2Section(content, "无集成场景声明");
  if (section === null) return null;
  const text = section.trim();
  return text.length > 0 ? text : null;
}

/** Build the M × 场景 coverage matrix: for each M-number, which scenario ids
 *  reference it. Deterministically generated from `关联指标` — never hand-judged. */
export function buildCoverageMatrix(
  scenarios: TestPlanScenario[],
): { metricId: string; scenarioIds: string[] }[] {
  const byMetric = new Map<string, string[]>();
  for (const s of scenarios) {
    for (const m of s.metricRefs) {
      if (!byMetric.has(m)) byMetric.set(m, []);
      byMetric.get(m)!.push(s.id);
    }
  }
  return [...byMetric.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([metricId, scenarioIds]) => ({ metricId, scenarioIds }));
}
