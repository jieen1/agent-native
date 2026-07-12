/**
 * F5 任务拆分阈值(规划前置契约) — 规模估算纯函数。
 *
 * 设计权威:docs/sdlc-product-design/02-workflows.md §3.10 拆分契约
 * ("spec/brief 涉及 >6 个文件、或跨生命周期协同 … → 拒绝单节点派发,强制拆为
 * 多个 dev 子任务")。实施细则:docs/sdlc-impl-f5-f10.md §1A。
 *
 * 纯文本进、结构出,无 I/O、无数据库、无随机性 —— 同一 briefText 永远得到
 * 同一结果(estimate-brief-scale action 的幂等性 T-F5-02 直接依赖这一点)。
 *
 * 启发式(与 §1A 表格逐条对应):
 *  ① 文件路径样式计数 —— 反引号内 `xx/yy.ext` 形态的路径,按去重后的路径数计。
 *  ② 生命周期关键词共现 —— schema/迁移、action、页面/组件、调度器/插件 四类
 *     关键词组,命中 ≥3 组即 crossLifecycle=true(跨生命周期协同信号,即使
 *     单类文件数不多,协同面已经超出单节点范围)。
 *  ③ verdict = files > 6 || crossLifecycle ? 'split-required' : 'ok'。
 */

export interface ScaleEstimateResult {
  /** Distinct file paths detected in the brief text (backtick-quoted, with a
   *  path separator and a recognized source-file extension). */
  files: number;
  /** True when ≥3 of the 4 lifecycle keyword groups co-occur in the text. */
  crossLifecycle: boolean;
  /** Human/UI-facing evidence trail: `file:<path>` entries (used by the S2
   *  split dialog to pre-fill child drafts by file cluster) and
   *  `lifecycle:<group>` entries for the groups that matched. */
  signals: string[];
  verdict: "ok" | "split-required";
}

// Matches a backtick-quoted path with at least one `/` and a recognized
// source-file extension, e.g. `` `server/lib/foo.ts` `` or
// `` `app/pages/Bar.tsx` ``. Deliberately generous on extensions beyond the
// literal "ts(x)" in the doc's shorthand — real briefs reference schema SQL,
// config JSON, styles, etc., and all of those are still "a file" for scale
// purposes.
const FILE_PATH_RE =
  /`([\w][\w\-./]*\/[\w][\w\-.]*\.(?:tsx?|jsx?|mjs|cjs|sql|json|md|css|scss|py|go|rs|vue|ya?ml))`/g;

interface LifecycleGroup {
  key: string;
  patterns: RegExp[];
}

// Four lifecycle-stage keyword groups (schema/迁移 + action + 页面/组件 +
// 调度器/插件) — §1A: "生命周期关键词共现 … ≥3 类即 crossLifecycle".
const LIFECYCLE_GROUPS: LifecycleGroup[] = [
  { key: "schema-migration", patterns: [/schema/i, /迁移/, /migration/i] },
  { key: "action", patterns: [/\baction\b/i, /actions?[\\/]/i] },
  { key: "ui", patterns: [/页面/, /组件/, /\bpage\b/i, /\bcomponent\b/i] },
  {
    key: "scheduler-plugin",
    patterns: [/调度器/, /插件/, /\bscheduler\b/i, /\bplugin\b/i],
  },
];

export function estimateScale(
  briefText: string | null | undefined,
): ScaleEstimateResult {
  const text = briefText ?? "";

  const fileMatches = new Set<string>();
  const re = new RegExp(FILE_PATH_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    fileMatches.add(m[1]!);
  }
  const files = fileMatches.size;

  const matchedGroups = LIFECYCLE_GROUPS.filter((g) =>
    g.patterns.some((p) => p.test(text)),
  );
  const crossLifecycle = matchedGroups.length >= 3;

  const signals: string[] = [
    ...Array.from(fileMatches).map((f) => `file:${f}`),
    ...matchedGroups.map((g) => `lifecycle:${g.key}`),
  ];

  const verdict: ScaleEstimateResult["verdict"] =
    files > 6 || crossLifecycle ? "split-required" : "ok";

  return { files, crossLifecycle, signals, verdict };
}
