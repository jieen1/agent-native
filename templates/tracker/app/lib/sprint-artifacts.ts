// Pure helper for the Sprint 驾驶舱's 产物库 三段式分组 (SprintDetailPage.tsx,
// 03-tracker.md §5.2 ③ / §11 docKey list). Framework-free so it's unit
// testable without a DOM.
export type ArtifactGroup = "规划" | "设计" | "验证" | "其他";

export const ARTIFACT_GROUP_ORDER: ArtifactGroup[] = [
  "规划",
  "设计",
  "验证",
  "其他",
];

const EXACT_GROUP: Record<string, ArtifactGroup> = {
  "sprint-doc": "规划",
  "test-plan": "规划",
  "brainstorm-notes": "规划",
  "ui-spec": "设计",
  "ui-prototype": "设计",
  "technical-design": "设计",
  "briefs-index": "设计",
  briefs: "设计",
  "verify-report": "验证",
  story: "验证",
  "spike-report": "验证",
};

/** Classify a sprint artifact's docKey into one of the driving-cockpit's
 *  three named groups. Prefixed keys (`brief:<itemKey>`, `audit-report:<n>`)
 *  are matched by prefix; anything unrecognized lands in "其他" instead of
 *  silently disappearing. */
export function classifyDocKey(docKey: string): ArtifactGroup {
  const exact = EXACT_GROUP[docKey];
  if (exact) return exact;
  if (docKey.startsWith("brief:")) return "设计";
  if (docKey.startsWith("audit-report:")) return "验证";
  return "其他";
}
