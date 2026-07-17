/**
 * Deterministic markdown parsing helpers for the `ui-spec` artifact
 * (`/ui-spec` skill output). Used by `extract-briefs` (screen-summary
 * injection into briefs) and `check-artifact-gates` (every In-Scope outcome
 * maps to a screen or an explicit "no UI" declaration).
 *
 * Convention this module assumes (authored by `/ui-spec`'s SKILL.md):
 *
 *   ## 屏清单
 *   - S1 · 登录页
 *   - S2 · 仪表盘
 *
 *   ## 无界面 Outcomes
 *   - O3: 纯后端定时任务，无用户可见界面
 *
 *   ## 逐屏规格
 *
 *   ### S1 · 登录页
 *   - **目标**: ...
 *   - **主操作**: ...
 *   - **数据状态**: ...
 *   - **空态**: ...
 *   - **关联 Outcome**: O1, O2
 */

const H2_RE = /^##\s+(.+?)\s*$/;
const H3_SCREEN_RE = /^###\s+(S\d+)\s*[·:]\s*(.+?)\s*$/;
const FIELD_RE = /^[-*]\s*\*\*(.+?)\*\*\s*[:：]\s*(.+)$/;
const NO_UI_OUTCOME_RE = /^[-*]\s*(O\d+)\s*[:：]/;

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

export interface UiSpecScreen {
  id: string;
  title: string;
  fields: Record<string, string>;
  /** Outcome ids from this screen's `**关联 Outcome**` field ("无" → empty). */
  outcomeRefs: string[];
}

/** Parse every `### S{n} · {title}` screen card under `## 逐屏规格`. */
export function parseUiSpecScreens(content: string): UiSpecScreen[] {
  const section = extractH2Section(content, "逐屏规格");
  if (section === null) return [];
  const lines = section.split("\n");
  const boundaries: Array<{ idx: number; id: string; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = H3_SCREEN_RE.exec(lines[i]!.trim());
    if (m) boundaries.push({ idx: i, id: m[1]!, title: m[2]! });
  }

  const screens: UiSpecScreen[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const cur = boundaries[i]!;
    const next = boundaries[i + 1];
    const body = lines.slice(cur.idx + 1, next ? next.idx : lines.length);
    const fields: Record<string, string> = {};
    let outcomeRefs: string[] = [];
    for (const raw of body) {
      const m = FIELD_RE.exec(raw.trim());
      if (!m) continue;
      const key = m[1]!.trim();
      const value = m[2]!.trim();
      fields[key] = value;
      if (key === "关联 Outcome") {
        outcomeRefs = /^(无|none)$/i.test(value)
          ? []
          : value
              .split(/[,，、]/)
              .map((s) => s.trim())
              .filter(Boolean);
      }
    }
    screens.push({ id: cur.id, title: cur.title, fields, outcomeRefs });
  }
  return screens;
}

/** Parse `## 屏清单` bullet ids (`S1`, `S2`, ...) in declared order. */
export function parseScreenList(content: string): string[] {
  const section = extractH2Section(content, "屏清单");
  if (section === null) return [];
  const ids: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^[-*]\s*(S\d+)\b/.exec(line.trim());
    if (m) ids.push(m[1]!);
  }
  return ids;
}

/** Outcome ids explicitly declared as having no UI (`## 无界面 Outcomes`). */
export function parseNoUiOutcomes(content: string): string[] {
  const section = extractH2Section(content, "无界面 Outcomes");
  if (section === null) return [];
  const ids: string[] = [];
  for (const line of section.split("\n")) {
    const m = NO_UI_OUTCOME_RE.exec(line.trim());
    if (m) ids.push(m[1]!);
  }
  return ids;
}

/**
 * Build a short, non-HTML summary of one screen for injection into a
 * `brief:{itemKey}` artifact ("屏规格摘要，非 HTML" per
 * r4-workflow-families-planning-skills.md §5.3).
 */
export function summarizeScreen(screen: UiSpecScreen): string {
  const lines = [`${screen.id} · ${screen.title}`];
  for (const key of ["目标", "主操作", "数据状态", "空态"]) {
    if (screen.fields[key]) lines.push(`  - ${key}: ${screen.fields[key]}`);
  }
  return lines.join("\n");
}
