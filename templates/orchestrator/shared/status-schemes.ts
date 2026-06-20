// ===========================================================================
// WORK-ITEM STATUS SCHEMES (the PM core — DESIGN §6.2a / §6.2b).
//
// A scheme encodes ONE work-item type's business-status pipeline: the ordered
// stages (each tagged with a `category`), the listed back/exit transitions
// (rework | cancel | reopen), and `resolutionsAt` (which resolutions are legal
// at each completed/cancelled terminal stage). Forward moves are IMPLICIT by
// stage order (skip-forward allowed); only rework/cancel/reopen are enumerated.
//
// These default schemes are the template; a project may override any type's
// scheme via `projects.status_schemes` (§9). The transition VALIDATOR
// (`evaluateTransition`) is the single algorithm `transition-work-item` runs to
// decide legality + derive statusCategory + enforce resolution rules.
//
// This module is PURE (no DB, no IO) so both the action and unit tests use it.
// ===========================================================================

/** The four orthogonal stage categories (DESIGN §6.2a). completed ≠ cancelled. */
export type StatusCategory = "todo" | "in-progress" | "completed" | "cancelled";

export const STATUS_CATEGORIES: StatusCategory[] = [
  "todo",
  "in-progress",
  "completed",
  "cancelled",
];

/** The work-item types that carry a built-in default scheme (DESIGN §6.2a). */
export type WorkItemType = "requirement" | "bug" | "prod-issue" | "task";

export const WORK_ITEM_TYPES: WorkItemType[] = [
  "requirement",
  "bug",
  "prod-issue",
  "task",
];

/** The closed set of resolutions (DESIGN §6.2a). */
export type Resolution =
  | "shipped"
  | "cancelled"
  | "rejected"
  | "duplicate"
  | "cannot-reproduce"
  | "rolled-back"
  | "deferred";

export const RESOLUTIONS: Resolution[] = [
  "shipped",
  "cancelled",
  "rejected",
  "duplicate",
  "cannot-reproduce",
  "rolled-back",
  "deferred",
];

/** A `deferred` resolution is a soft-cancel, excluded from the killed metric. */
export const SOFT_CANCEL_RESOLUTIONS: Resolution[] = ["deferred"];

/** The kinds of explicitly-listed (non-forward) transition (DESIGN §6.2a). */
export type TransitionKind = "rework" | "cancel" | "reopen";

/** One stage in a type's ordered pipeline. */
export interface StageDef {
  /** Stable key (also the display label here; UI maps via i18n later). */
  key: string;
  /** Human label (zh) — the same string as `key` for these default schemes. */
  label: string;
  /** Which of the four categories this stage belongs to. */
  category: StatusCategory;
  /** True for completed/cancelled stages (a resolution is required to enter). */
  terminal?: boolean;
  /** A removed-but-not-deleted stage kept so live items don't strand (§6.2a). */
  deprecated?: boolean;
}

/** A listed (non-forward) transition edge. */
export interface TransitionDef {
  from: string;
  to: string;
  kind: TransitionKind;
}

/**
 * One work-item type's full scheme. `version` lets a project pin/evolve it
 * (bump + mark removed stages `deprecated`, never delete — §6.2a). Forward edges
 * are implicit by `stages` order; `transitions` lists only rework/cancel/reopen.
 */
export interface StatusScheme {
  version: number;
  stages: StageDef[];
  transitions: TransitionDef[];
  /** Per terminal stage key → the resolutions legal when entering it. */
  resolutionsAt: Record<string, Resolution[]>;
  /** reopen re-entry stage key (where a closed/cancelled item lands on reopen). */
  reopenTarget: string;
  /** Default rework target = the type's first in-progress stage. */
  reworkTarget: string;
}

/** A full set of schemes, one per type (+ optional extra schemes like `docs`). */
export type SchemeSet = Record<string, StatusScheme>;

// ── helper to build a scheme from compact stage lists ──────────────────────────

function stagesFrom(
  todo: string[],
  inProgress: string[],
  completed: string[],
  cancelled: string[],
): StageDef[] {
  const mk = (
    keys: string[],
    category: StatusCategory,
    terminal: boolean,
  ): StageDef[] =>
    keys.map((key) => ({
      key,
      label: key,
      category,
      ...(terminal ? { terminal: true } : {}),
    }));
  return [
    ...mk(todo, "todo", false),
    ...mk(inProgress, "in-progress", false),
    ...mk(completed, "completed", true),
    ...mk(cancelled, "cancelled", true),
  ];
}

// ── the four default per-type schemes (DESIGN §6.2a tables, verbatim) ──────────

const REQUIREMENT: StatusScheme = {
  version: 1,
  stages: stagesFrom(
    ["待分析", "待开发"],
    [
      "开发中",
      "待评审",
      "评审中",
      "待提测",
      "测试中",
      "待验收",
      "验收中",
      "待发布",
    ],
    ["已上线"],
    ["已取消", "已拒绝"],
  ),
  transitions: [
    // rework back-edges from review/test/acceptance → first in-progress stage.
    { from: "评审中", to: "开发中", kind: "rework" },
    { from: "测试中", to: "开发中", kind: "rework" },
    { from: "验收中", to: "开发中", kind: "rework" },
    // cancel from any non-terminal stage → 已取消.
    { from: "待分析", to: "已取消", kind: "cancel" },
    { from: "待开发", to: "已取消", kind: "cancel" },
    { from: "开发中", to: "已取消", kind: "cancel" },
    { from: "待评审", to: "已取消", kind: "cancel" },
    { from: "评审中", to: "已取消", kind: "cancel" },
    { from: "待提测", to: "已取消", kind: "cancel" },
    { from: "测试中", to: "已取消", kind: "cancel" },
    { from: "待验收", to: "已取消", kind: "cancel" },
    { from: "验收中", to: "已取消", kind: "cancel" },
    { from: "待发布", to: "已取消", kind: "cancel" },
    // reject (a cancelled-category terminal) reachable from review.
    { from: "待评审", to: "已拒绝", kind: "cancel" },
    { from: "评审中", to: "已拒绝", kind: "cancel" },
    // reopen from terminal → re-entry stage.
    { from: "已上线", to: "待开发", kind: "reopen" },
    { from: "已取消", to: "待开发", kind: "reopen" },
    { from: "已拒绝", to: "待开发", kind: "reopen" },
  ],
  resolutionsAt: {
    已上线: ["shipped"],
    已取消: ["cancelled", "deferred"],
    已拒绝: ["rejected", "duplicate"],
  },
  reopenTarget: "待开发",
  reworkTarget: "开发中",
};

const BUG: StatusScheme = {
  version: 1,
  stages: stagesFrom(
    ["待确认", "待修复"],
    [
      "修复中",
      "待评审",
      "评审中",
      "待提测",
      "测试中",
      "待验收",
      "验收中",
      "待发布",
    ],
    ["已关闭"],
    ["已取消", "不予处理"],
  ),
  transitions: [
    { from: "评审中", to: "修复中", kind: "rework" },
    { from: "测试中", to: "修复中", kind: "rework" },
    { from: "验收中", to: "修复中", kind: "rework" },
    { from: "待确认", to: "已取消", kind: "cancel" },
    { from: "待修复", to: "已取消", kind: "cancel" },
    { from: "修复中", to: "已取消", kind: "cancel" },
    { from: "待评审", to: "已取消", kind: "cancel" },
    { from: "评审中", to: "已取消", kind: "cancel" },
    { from: "待提测", to: "已取消", kind: "cancel" },
    { from: "测试中", to: "已取消", kind: "cancel" },
    { from: "待验收", to: "已取消", kind: "cancel" },
    { from: "验收中", to: "已取消", kind: "cancel" },
    { from: "待发布", to: "已取消", kind: "cancel" },
    // 不予处理 (won't-fix) reachable from triage/confirm.
    { from: "待确认", to: "不予处理", kind: "cancel" },
    { from: "待修复", to: "不予处理", kind: "cancel" },
    { from: "已关闭", to: "待修复", kind: "reopen" },
    { from: "已取消", to: "待修复", kind: "reopen" },
    { from: "不予处理", to: "待修复", kind: "reopen" },
  ],
  resolutionsAt: {
    已关闭: ["shipped", "cannot-reproduce", "duplicate", "rolled-back"],
    已取消: ["cancelled", "deferred"],
    不予处理: ["rejected", "duplicate"],
  },
  reopenTarget: "待修复",
  reworkTarget: "修复中",
};

const PROD_ISSUE: StatusScheme = {
  version: 1,
  stages: stagesFrom(
    ["已触发"],
    [
      "止血中",
      "已恢复",
      "复盘中",
      "根因修复中",
      "修复验证中",
      "灰度发布中",
      "待发布",
    ],
    ["已关闭"],
    ["已取消"],
  ),
  transitions: [
    // rework: a failed fix-verification goes back to root-cause fixing.
    { from: "修复验证中", to: "根因修复中", kind: "rework" },
    { from: "灰度发布中", to: "根因修复中", kind: "rework" },
    { from: "已触发", to: "已取消", kind: "cancel" },
    { from: "止血中", to: "已取消", kind: "cancel" },
    { from: "已恢复", to: "已取消", kind: "cancel" },
    { from: "复盘中", to: "已取消", kind: "cancel" },
    { from: "根因修复中", to: "已取消", kind: "cancel" },
    { from: "修复验证中", to: "已取消", kind: "cancel" },
    { from: "灰度发布中", to: "已取消", kind: "cancel" },
    { from: "待发布", to: "已取消", kind: "cancel" },
    { from: "已关闭", to: "复盘中", kind: "reopen" },
    { from: "已取消", to: "复盘中", kind: "reopen" },
  ],
  resolutionsAt: {
    // 已关闭(prod-issue) → shipped · rolled-back (DESIGN §6.2a explicit).
    已关闭: ["shipped", "rolled-back"],
    已取消: ["cancelled", "deferred"],
  },
  reopenTarget: "复盘中",
  reworkTarget: "止血中",
};

const TASK: StatusScheme = {
  version: 1,
  stages: stagesFrom(
    ["待办"],
    ["进行中", "待评审", "待测试", "测试中", "待验收"],
    ["已完成"],
    ["已取消"],
  ),
  transitions: [
    { from: "待评审", to: "进行中", kind: "rework" },
    { from: "测试中", to: "进行中", kind: "rework" },
    { from: "待验收", to: "进行中", kind: "rework" },
    { from: "待办", to: "已取消", kind: "cancel" },
    { from: "进行中", to: "已取消", kind: "cancel" },
    { from: "待评审", to: "已取消", kind: "cancel" },
    { from: "待测试", to: "已取消", kind: "cancel" },
    { from: "测试中", to: "已取消", kind: "cancel" },
    { from: "待验收", to: "已取消", kind: "cancel" },
    { from: "已完成", to: "待办", kind: "reopen" },
    { from: "已取消", to: "待办", kind: "reopen" },
  ],
  resolutionsAt: {
    已完成: ["shipped"],
    已取消: ["cancelled", "deferred"],
  },
  reopenTarget: "待办",
  reworkTarget: "进行中",
};

/**
 * A DOCS scheme (DESIGN §6.2a / IMPLEMENTATION P3 §G): non-code projects (a
 * requirement doc, a deck) should NOT be forced through test/release stages —
 * a short 待写作 · 撰写中 · 评审中 · 定稿 pipeline. Available as an extra scheme a
 * project can map a type onto via `status_schemes` (it is not one of the four
 * built-in `type` enums, so it lives under the `docs` key in the default set).
 */
const DOCS: StatusScheme = {
  version: 1,
  stages: stagesFrom(["待写作"], ["撰写中", "评审中"], ["定稿"], ["已取消"]),
  transitions: [
    { from: "评审中", to: "撰写中", kind: "rework" },
    { from: "待写作", to: "已取消", kind: "cancel" },
    { from: "撰写中", to: "已取消", kind: "cancel" },
    { from: "评审中", to: "已取消", kind: "cancel" },
    { from: "定稿", to: "撰写中", kind: "reopen" },
    { from: "已取消", to: "撰写中", kind: "reopen" },
  ],
  resolutionsAt: {
    定稿: ["shipped"],
    已取消: ["cancelled", "deferred"],
  },
  reopenTarget: "撰写中",
  reworkTarget: "撰写中",
};

/**
 * The default scheme set, keyed by work-item type (+ the extra `docs` scheme).
 * A project's `status_schemes` JSON, when present, overrides any of these keys.
 */
export const DEFAULT_SCHEMES: SchemeSet = {
  requirement: REQUIREMENT,
  bug: BUG,
  "prod-issue": PROD_ISSUE,
  task: TASK,
  docs: DOCS,
};

/** Deep-clone the default set (so callers never mutate the shared constant). */
export function defaultSchemeSet(): SchemeSet {
  return JSON.parse(JSON.stringify(DEFAULT_SCHEMES)) as SchemeSet;
}

// ── scheme lookups ─────────────────────────────────────────────────────────────

/** The stage's order index in the scheme (−1 if not found). */
export function stageIndex(scheme: StatusScheme, stageKey: string): number {
  return scheme.stages.findIndex((s) => s.key === stageKey);
}

/** The stage's category, or null if the stage is unknown to the scheme. */
export function categoryOf(
  scheme: StatusScheme,
  stageKey: string,
): StatusCategory | null {
  return scheme.stages.find((s) => s.key === stageKey)?.category ?? null;
}

/** The scheme's initial stage = the first `todo` stage (where create-work-item lands). */
export function initialStage(scheme: StatusScheme): string {
  const first = scheme.stages.find((s) => s.category === "todo");
  return first?.key ?? scheme.stages[0]?.key ?? "";
}

/** Resolve the scheme for a type from a (possibly project-overridden) set. */
export function resolveScheme(
  schemes: SchemeSet,
  type: string,
): StatusScheme | null {
  return schemes[type] ?? null;
}

// ── the transition validator (DESIGN §6.2a / IMPLEMENTATION P3 pseudocode) ─────

/** Options a transition may carry (mirrors transition-work-item args). */
export interface TransitionOptions {
  resolution?: Resolution | null;
  environment?: string | null;
  blocked?: boolean;
  blockedReason?: string | null;
  blockedBy?: string | null;
  severity?: string | null;
  /** True when a `duplicate-of` link from this item exists (resolution=duplicate gate). */
  hasDuplicateLink?: boolean;
}

/** A successful transition evaluation — what the action then persists. */
export interface TransitionDecision {
  ok: true;
  kind: "forward" | TransitionKind;
  toStatus: string;
  statusCategory: StatusCategory;
  /** Final resolution to persist (cleared on reopen, defaulted on cancel). */
  resolution: Resolution | null;
}

/** A rejected transition with a human-readable reason. */
export interface TransitionRejection {
  ok: false;
  error: string;
}

export type TransitionResult = TransitionDecision | TransitionRejection;

/**
 * True when `from→to` is a legal FORWARD move: same type, to-index strictly
 * greater than from-index, and NOT crossing into the cancelled category
 * (entering cancelled must go through a listed `cancel` edge so a resolution is
 * forced). Skip-forward is allowed (开发中→待发布 in one call) — DESIGN §6.2a.
 */
function isForward(scheme: StatusScheme, from: string, to: string): boolean {
  const fi = stageIndex(scheme, from);
  const ti = stageIndex(scheme, to);
  if (fi < 0 || ti < 0) return false;
  if (ti <= fi) return false;
  return categoryOf(scheme, to) !== "cancelled";
}

/** Find a listed transition edge from→to (rework/cancel/reopen), or null. */
function listedTransition(
  scheme: StatusScheme,
  from: string,
  to: string,
): TransitionDef | null {
  return scheme.transitions.find((t) => t.from === from && t.to === to) ?? null;
}

/**
 * Evaluate a `from → to` transition against a scheme (the SOLE algorithm
 * `transition-work-item` runs). Pure; returns a decision the action persists or
 * a rejection with a clear error. Encodes, exactly, the IMPLEMENTATION §P3
 * "transition 校验器" pseudocode:
 *
 *  - forward (skip-forward allowed) → kind "forward"
 *  - else a listed transition       → its kind (rework | cancel | reopen)
 *  - else                            → reject "illegal transition"
 *  - reopen: must target the type's reopenTarget; CLEARS resolution
 *  - cancel: resolution defaults to "cancelled"
 *  - entering completed/cancelled: REQUIRES a resolution from resolutionsAt[to]
 *  - resolution=duplicate: REQUIRES a duplicate-of link
 *  - derives statusCategory from the to-stage
 */
export function evaluateTransition(
  scheme: StatusScheme,
  from: string,
  to: string,
  opts: TransitionOptions = {},
): TransitionResult {
  if (stageIndex(scheme, to) < 0) {
    return { ok: false, error: `unknown target stage '${to}'` };
  }
  if (stageIndex(scheme, from) < 0) {
    return { ok: false, error: `unknown source stage '${from}'` };
  }
  if (from === to) {
    return { ok: false, error: `no-op transition (from == to == '${to}')` };
  }

  let kind: TransitionDecision["kind"];
  if (isForward(scheme, from, to)) {
    kind = "forward";
  } else {
    const listed = listedTransition(scheme, from, to);
    if (!listed) {
      return {
        ok: false,
        error: `illegal transition '${from}' → '${to}' (not a forward move and not a listed rework/cancel/reopen edge)`,
      };
    }
    kind = listed.kind;
  }

  let resolution: Resolution | null = opts.resolution ?? null;

  if (kind === "reopen") {
    if (to !== scheme.reopenTarget) {
      return {
        ok: false,
        error: `reopen must target the type's re-entry stage '${scheme.reopenTarget}', not '${to}'`,
      };
    }
    // reopen CLEARS resolution (the classic "Done-but-resolved" defect — §6.2a).
    resolution = null;
  }
  if (kind === "cancel") {
    // cancel defaults resolution to "cancelled" when none supplied.
    resolution = resolution ?? "cancelled";
  }

  const cat = categoryOf(scheme, to);
  if (cat == null) {
    return { ok: false, error: `target stage '${to}' has no category` };
  }

  if (cat === "completed" || cat === "cancelled") {
    const allowed = scheme.resolutionsAt[to] ?? [];
    if (resolution == null) {
      return {
        ok: false,
        error: `entering '${to}' (${cat}) requires a resolution; allowed: ${allowed.join(", ") || "(none defined)"}`,
      };
    }
    if (!allowed.includes(resolution)) {
      return {
        ok: false,
        error: `resolution '${resolution}' is not valid at '${to}'; allowed: ${allowed.join(", ")}`,
      };
    }
    if (resolution === "duplicate" && !opts.hasDuplicateLink) {
      return {
        ok: false,
        error: `resolution 'duplicate' requires a 'duplicate-of' link from this item (none found)`,
      };
    }
  } else {
    // A non-terminal stage carries no resolution (reopen already cleared it).
    resolution = kind === "reopen" ? null : resolution;
  }

  return {
    ok: true,
    kind,
    toStatus: to,
    statusCategory: cat,
    resolution,
  };
}
