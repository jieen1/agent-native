// F5 任务拆分阈值(规划前置契约) — pure UI-logic helpers for the S2/S4 split
// dialog (docs/sdlc-impl-f5-f10.md §1B "拆分对话框"). Kept side-effect-free
// and framework-independent (no React) so they're directly vitest-testable
// without a DOM/RTL harness — this template's test suite is logic-only (see
// app/pages/__tests__/sprint.test.ts), matching that convention.

export interface SplitDraftRow {
  title: string;
  description: string;
}

const FILE_SIGNAL_PREFIX = "file:";
const MAX_FILES_PER_CHILD = 6;

/**
 * Pre-fill draft split rows from an estimate's `signals` array, grouping the
 * `file:<path>` entries into clusters of ≤6 files each (§1B: "按 signals 里
 * 的文件簇分组建议(每组 ≤6 文件)生成 2–3 行草稿"). Always returns at least 2
 * rows (the dialog's own min-2 validation) — if there weren't enough file
 * signals to naturally produce two clusters (e.g. a crossLifecycle-only
 * verdict with few detected paths), pads with empty rows for the user to
 * fill in by hand.
 */
export function buildDraftChildren(signals: string[]): SplitDraftRow[] {
  const files = signals
    .filter((s) => s.startsWith(FILE_SIGNAL_PREFIX))
    .map((s) => s.slice(FILE_SIGNAL_PREFIX.length));

  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += MAX_FILES_PER_CHILD) {
    chunks.push(files.slice(i, i + MAX_FILES_PER_CHILD));
  }
  while (chunks.length < 2) chunks.push([]);

  return chunks.map((chunk, idx) => ({
    title: `子单 ${idx + 1}`,
    description: chunk.join(", "),
  }));
}

/** Submit-button validity (§1B: "校验: ≥2 行、title 非空"). */
export function canSubmitSplit(rows: Pick<SplitDraftRow, "title">[]): boolean {
  return rows.length >= 2 && rows.every((r) => r.title.trim().length > 0);
}
