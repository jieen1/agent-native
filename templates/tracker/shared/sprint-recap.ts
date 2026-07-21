// M5 度量复盘 — Sprint recap (human-intervention timeline) derivation (pure,
// framework-free). Mirrors app/lib/sprint-metrics.ts's convention so it is
// unit-testable without a DOM.
//
// The recap answers: "where did humans have to intervene, and why?" — derived
// STRICTLY from real tracker records (approvals, human comments, stage
// rollbacks, superseded re-dispatches). NEVER fabricated: if there are no
// interventions, the recap says so explicitly. Each timeline entry cites its
// source record id so it is auditable.

export type RecapCategory = "approval" | "correction" | "escalation";

export interface RecapApprovalRow {
  id: string;
  gateKey: string;
  status: string; // pending | approved | rejected
  requestedBy: string | null;
  decidedBy: string | null;
  reason: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface RecapCommentRow {
  id: string;
  authorKind: string; // human | agent
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface RecapStageRow {
  id: string;
  stageName: string;
  stageStatus: string; // 已驳回 = rolled back
  verdictReason: string | null;
  updatedAt: string;
}

export interface RecapRunRow {
  id: string;
  superseded: number | boolean;
  createdAt: string;
}

export interface RecapEntry {
  /** ISO timestamp used for chronological ordering. */
  at: string;
  category: RecapCategory;
  what: string;
  who: string | null;
  why: string | null;
  /** Exact source record id (e.g. "approval:apr_x", "comment:cmt_y"). */
  source: string;
}

export interface SprintRecap {
  entries: RecapEntry[];
  counts: Record<RecapCategory, number>;
  /** True when there were zero human interventions — the honest case. */
  noInterventions: boolean;
}

function ts(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Build the chronological human-intervention timeline from real record rows.
 * Pure + deterministic: same inputs → same output, no fabrication.
 */
export function buildSprintRecap(input: {
  approvals: RecapApprovalRow[];
  comments: RecapCommentRow[];
  stages: RecapStageRow[];
  runs: RecapRunRow[];
}): SprintRecap {
  const entries: RecapEntry[] = [];

  // Approvals — every requested/granted/rejected gate is a human decision point.
  for (const a of input.approvals) {
    const decided = a.status === "approved" || a.status === "rejected";
    entries.push({
      at: (decided && a.decidedAt) || a.createdAt,
      category: a.status === "rejected" ? "escalation" : "approval",
      what:
        a.status === "approved"
          ? `审批通过 ${a.gateKey}`
          : a.status === "rejected"
            ? `审批驳回 ${a.gateKey}`
            : `发起审批 ${a.gateKey}`,
      who: (decided ? a.decidedBy : a.requestedBy) ?? a.requestedBy,
      why: a.reason,
      source: `approval:${a.id}`,
    });
  }

  // Human-authored comments — course corrections / direction changes.
  for (const c of input.comments) {
    if (c.authorKind !== "human") continue;
    entries.push({
      at: c.createdAt,
      category: "correction",
      what: "人工评论",
      who: c.authorName,
      why: c.body,
      source: `comment:${c.id}`,
    });
  }

  // Stage rollbacks (已驳回) — escalations that sent work back.
  for (const s of input.stages) {
    if (s.stageStatus !== "已驳回") continue;
    entries.push({
      at: s.updatedAt,
      category: "escalation",
      what: `阶段驳回 ${s.stageName}`,
      who: null,
      why: s.verdictReason,
      source: `stage:${s.id}`,
    });
  }

  // Superseded re-dispatches — a first run was replaced (often a failed/wrong
  // attempt) → a course correction.
  for (const r of input.runs) {
    const superseded =
      r.superseded === true || r.superseded === 1 ? true : false;
    if (!superseded) continue;
    entries.push({
      at: r.createdAt,
      category: "correction",
      what: "重新派发(上一轮被取代)",
      who: null,
      why: null,
      source: `run:${r.id}`,
    });
  }

  entries.sort((a, b) => ts(a.at) - ts(b.at));

  const counts: Record<RecapCategory, number> = {
    approval: 0,
    correction: 0,
    escalation: 0,
  };
  for (const e of entries) counts[e.category]++;

  return { entries, counts, noInterventions: entries.length === 0 };
}

const CATEGORY_LABELS: Record<RecapCategory, string> = {
  approval: "审批",
  correction: "纠偏",
  escalation: "升级",
};

/** Render the recap as a Markdown artifact body (deterministic). */
export function renderSprintRecapMarkdown(
  sprintName: string,
  recap: SprintRecap,
): string {
  const lines: string[] = [];
  lines.push(`# Sprint Recap — ${sprintName}`);
  lines.push("");
  if (recap.noInterventions) {
    lines.push(
      "本 Sprint 全程无人工干预记录(approvals / 人工评论 / 阶段驳回 / 重新派发均为空)。",
    );
    lines.push("");
    return lines.join("\n");
  }

  lines.push(
    `共 ${recap.entries.length} 处人工干预:审批 ${recap.counts.approval} · 纠偏 ${recap.counts.correction} · 升级 ${recap.counts.escalation}`,
  );
  lines.push("");
  lines.push("| 时间 | 类别 | 事件 | 操作人 | 来源 |");
  lines.push("|------|------|------|--------|------|");
  for (const e of recap.entries) {
    const why = e.why ? ` — ${e.why.replace(/\|/g, "\\|")}` : "";
    lines.push(
      `| ${e.at} | ${CATEGORY_LABELS[e.category]} | ${e.what}${why} | ${e.who ?? "-"} | \`${e.source}\` |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
