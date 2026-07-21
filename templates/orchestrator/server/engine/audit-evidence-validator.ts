/**
 * Phase H goal-audit — mechanical anti-flattery evidence validator
 * (docs/sdlc-product-design/02-workflows.md §3.3 `sdlc-gap-analysis` /
 * `sdlc-audit` 反奉承 schema).
 *
 * Pure TypeScript, zero I/O, zero LLM — unit-testable in isolation. This is
 * the mechanical heart of the goal-audit workflow: it runs INSIDE the same
 * `output_schema` validation path the V3 dispatcher already uses for every
 * judgment node (`v3-dispatcher.ts`'s `classifyOutput`), so a report that
 * violates any rule below is REJECTED at the schema layer (the node is marked
 * `schema-violation` and retried) rather than merely being "asked for" in the
 * prompt and hoped for. Prompt text can be ignored by a model; these checks
 * cannot.
 *
 * Why mechanical (the lessons this encodes):
 *  - L15 (desktop-launcher-shipped-on-seed-data, 16 fix PRs): a "user-facing
 *    capability" metric whose only evidence is "tests pass" / "ran the demo"
 *    / "seed data" is NOT proof the capability works for a real user. Rule 6
 *    forces real runtime evidence (real entry point + real NON-seed input +
 *    captured real output) for any `userFacing` metric.
 *  - "Surface green, real gap": green validation logs do not prove the goal
 *    is met. Empty words ("done"/"✓"/"implemented") and bragging text
 *    ("圆满完成"/"flawless") are rejected as evidence (rules 1 & 5).
 *  - "Silent metric shrink": the auditor may not quietly audit fewer metrics
 *    than the plan predicted (rule 4).
 *  - "NO_GAPS with no discretion": a NO_GAPS verdict is only legal when every
 *    P0 metric is MET and there is no blocking concern — otherwise the report
 *    is rejected, so an auditor that wants to flag a problem MUST say
 *    GAPS_FOUND (the NO_GAPS gate, below).
 *
 * The plain JSON-schema shape (the `AUDIT_REPORT_OUTPUT_SCHEMA` export) is
 * what the DAG node carries as `output_schema`; ajv enforces the structural
 * shape first, and `validateAuditReport` enforces the six semantic rules that
 * JSON-schema alone cannot express.
 */

// ── Report shape ─────────────────────────────────────────────────────────────

export type AuditVerdict = "NO_GAPS" | "GAPS_FOUND";
export type AuditMetricStatus = "MET" | "PARTIAL" | "NOT_MET";
export type AuditPriority = "P0" | "P1" | "P2";
export type AuditConcernType = "blocking" | "non-blocking" | string;

export interface AuditRuntimeEvidence {
  /** Real entry point that was exercised (a command / route / binary). */
  entrypoint?: unknown;
  /** A real, NON-seed input value. */
  realInput?: unknown;
  /** The real output captured from running the entry point on that input. */
  capturedOutput?: unknown;
}

export interface AuditMetric {
  name?: unknown;
  /** Absent ⇒ treated as P0 (rule 3 — omitting priority cannot dodge P0). */
  priority?: unknown;
  status?: unknown;
  evidence?: unknown;
  userFacing?: unknown;
  runtimeEvidence?: unknown;
}

export interface AuditConcern {
  type?: unknown;
  description?: unknown;
}

export interface AuditReport {
  verdict?: unknown;
  metrics?: unknown;
  audited_metrics_count?: unknown;
  predicted_metrics_count?: unknown;
  concerns?: unknown;
  summary?: unknown;
}

// ── The plain JSON-schema the DAG node carries as output_schema ──────────────
//
// ajv enforces this structural shape; the six semantic rules in
// `validateAuditReport` go beyond what JSON-schema can express. The custom
// `x-audit-evidence: true` marker is how `classifyOutput` recognizes an audit
// report schema and routes it through the mechanical validator (ajv is
// configured `strict:false`, so the unknown keyword is ignored there).

export const AUDIT_REPORT_OUTPUT_SCHEMA = {
  type: "object",
  "x-audit-evidence": true,
  required: [
    "verdict",
    "metrics",
    "audited_metrics_count",
    "predicted_metrics_count",
    "concerns",
    "summary",
  ],
  properties: {
    verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
    metrics: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "status", "evidence"],
        properties: {
          name: { type: "string" },
          priority: { type: "string", enum: ["P0", "P1", "P2"] },
          status: { type: "string", enum: ["MET", "PARTIAL", "NOT_MET"] },
          evidence: { type: "string" },
          userFacing: { type: "boolean" },
          runtimeEvidence: {
            type: "object",
            required: ["entrypoint", "realInput", "capturedOutput"],
            properties: {
              entrypoint: { type: "string" },
              realInput: { type: "string" },
              capturedOutput: { type: "string" },
            },
          },
        },
      },
    },
    audited_metrics_count: { type: "integer" },
    predicted_metrics_count: { type: "integer" },
    concerns: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "description"],
        properties: {
          type: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
} as const;

/** True when an `output_schema` is an audit-report schema (carries the
 *  `x-audit-evidence` marker). Used by `classifyOutput` to decide whether to
 *  run the mechanical validator after ajv passes. */
export function isAuditEvidenceSchema(schema: unknown): boolean {
  return (
    !!schema &&
    typeof schema === "object" &&
    (schema as Record<string, unknown>)["x-audit-evidence"] === true
  );
}

// ── Rule 1 — empty-word rejection ────────────────────────────────────────────
//
// Evidence that IS one of these words (trimmed, lowercased, whole-string) is
// an empty phrase, not evidence. A longer sentence that merely CONTAINS one of
// these words is handled by rule 2 (format) instead — this rule only rejects
// evidence whose ENTIRE body is a bare empty word.

const EMPTY_EVIDENCE_PHRASES = new Set<string>([
  "implemented",
  "complete",
  "completed",
  "merged",
  "done",
  "✓",
  "ok",
  "okay",
  "finished",
  "passed",
  "测试通过",
  "已完成",
  "完成",
]);

export function isEmptyEvidencePhrase(evidence: string): boolean {
  return EMPTY_EVIDENCE_PHRASES.has(evidence.trim().toLowerCase());
}

// ── Rule 2 — evidence format ─────────────────────────────────────────────────
//
// Accepted forms (whole-string, anchored):
//   repo:file[:line]   e.g. packages/core/src/x.ts:42  (a path with a slash)
//   PR#<n>             e.g. PR#123
//   <git sha>          40-char hex (full SHA) OR 7-39 hex chars that contain at
//                      least one digit (excludes hex-only dictionary words like
//                      "defaced"/"effaced" which have zero digit characters)
//   absence-of:<pat>   e.g. absence-of:TODO
// Anything else is rejected — "tests pass", "looks good", a bare filename with
// no path, etc.
//
// The short-sha check uses two alternatives: first the full 40-char SHA
// (case-insensitive, no digit required — statistically unambiguous), then a
// 7-39 char lowercase hex string that MUST contain at least one [0-9] digit
// so that pure-letter hex words are excluded.

const EVIDENCE_PATH_RE = /^[^\s:]+\/[^\s:]+(?::\d+)?$/;
const EVIDENCE_PR_RE = /^PR#\d+$/;
const EVIDENCE_ABSENCE_RE = /^absence-of:\S+$/;
// Full 40-char SHA (case-insensitive OK — impossible to be a dictionary word)
const EVIDENCE_FULL_SHA_RE = /^[0-9a-f]{40}$/i;
// Short SHA: 7-39 lowercase hex chars that include at least one digit
const EVIDENCE_SHORT_SHA_RE = /^(?=[0-9a-f]{7,39}$)(?=.*[0-9])[0-9a-f]+$/;

export function isValidEvidenceFormat(evidence: string): boolean {
  const s = evidence.trim();
  return (
    EVIDENCE_PATH_RE.test(s) ||
    EVIDENCE_PR_RE.test(s) ||
    EVIDENCE_ABSENCE_RE.test(s) ||
    EVIDENCE_FULL_SHA_RE.test(s) ||
    EVIDENCE_SHORT_SHA_RE.test(s)
  );
}

// ── Rule 3 — default P0 ──────────────────────────────────────────────────────

/** A metric with no declared priority is P0 (omitting priority cannot dodge
 *  the P0 gate). */
export function effectivePriority(metric: AuditMetric): AuditPriority {
  const p = metric.priority;
  if (p === "P0" || p === "P1" || p === "P2") return p;
  return "P0";
}

// ── Rule 5 — bragging-text rejection ─────────────────────────────────────────

const BRAGGING_PHRASES = [
  "圆满完成",
  "超预期",
  "完美",
  "出色完成",
  "mission accomplished",
  "exceeded expectations",
  "flawless",
  "perfectly",
];

export function containsBraggingText(text: string): boolean {
  const lower = text.toLowerCase();
  return BRAGGING_PHRASES.some((p) => lower.includes(p.toLowerCase()));
}

// ── Rule 6 — user-facing runtime evidence ────────────────────────────────────
//
// Weak "evidence" that is NOT acceptable as the sole basis for a user-facing
// capability metric (L15). Matched case-insensitively as a whole trimmed
// string OR as a substring — "tests pass", "all tests passed", "ran the demo",
// "seed data", "source reads fine" all fail.

const WEAK_USERFACING_EVIDENCE = [
  "tests pass",
  "test pass",
  "source reads fine",
  "ran the demo",
  "seed data",
];

export function isWeakUserFacingEvidence(evidence: string): boolean {
  const lower = evidence.trim().toLowerCase();
  return WEAK_USERFACING_EVIDENCE.some((w) => lower.includes(w));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** True when a runtimeEvidence object carries all three non-empty fields. */
export function hasRealRuntimeEvidence(re: unknown): boolean {
  if (!re || typeof re !== "object") return false;
  const r = re as AuditRuntimeEvidence;
  return (
    isNonEmptyString(r.entrypoint) &&
    isNonEmptyString(r.realInput) &&
    isNonEmptyString(r.capturedOutput)
  );
}

// ── The validator ────────────────────────────────────────────────────────────

export interface AuditValidationResult {
  ok: boolean;
  /** One entry per violated rule, each a human-readable rejection reason. */
  errors: string[];
}

/**
 * Mechanically validate a goal-audit report against the six anti-flattery
 * rules + the NO_GAPS gate. Returns `{ ok:false, errors }` when ANY rule is
 * violated — the caller (`classifyOutput`) turns that into a schema-violation
 * so the node fails and retries. Never throws.
 *
 * Assumes the report already passed ajv against `AUDIT_REPORT_OUTPUT_SCHEMA`
 * (so the structural types are present); the checks below are the SEMANTIC
 * layer JSON-schema cannot express, and are defensive about field types
 * regardless.
 */
export function validateAuditReport(report: unknown): AuditValidationResult {
  const errors: string[] = [];
  const r = (report ?? {}) as AuditReport;

  const metrics: AuditMetric[] = Array.isArray(r.metrics)
    ? (r.metrics as AuditMetric[])
    : [];
  const concerns: AuditConcern[] = Array.isArray(r.concerns)
    ? (r.concerns as AuditConcern[])
    : [];
  const summary = typeof r.summary === "string" ? r.summary : "";

  // Rule 1 + 2 + 6: per-metric evidence checks.
  metrics.forEach((m, i) => {
    const label =
      typeof m?.name === "string" && m.name.trim()
        ? `metric '${m.name}'`
        : `metric[${i}]`;
    const evidence = typeof m?.evidence === "string" ? m.evidence : "";

    // Rule 1 — non-empty and not a bare empty phrase.
    if (!evidence.trim()) {
      errors.push(`${label}: evidence 为空（必须给出具体证据）`);
    } else if (isEmptyEvidencePhrase(evidence)) {
      errors.push(
        `${label}: evidence 是空话（"${evidence.trim()}"），必须给出 repo:file[:line] / PR#n / sha / absence-of:<pattern> 形式的可核对证据`,
      );
    } else if (!isValidEvidenceFormat(evidence)) {
      // Rule 2 — accepted format.
      errors.push(
        `${label}: evidence 格式非法（"${evidence.trim()}"），仅接受 repo:file[:line] / PR#n / git sha(7-40 hex) / absence-of:<pattern>`,
      );
    }

    // Rule 6 — user-facing metrics need REAL runtime evidence.
    if (m?.userFacing === true) {
      if (!hasRealRuntimeEvidence(m.runtimeEvidence)) {
        errors.push(
          `${label}: 用户可感指标(userFacing)必须附真实运行证据 runtimeEvidence{entrypoint, realInput(非种子输入), capturedOutput}`,
        );
      }
      if (isWeakUserFacingEvidence(evidence)) {
        errors.push(
          `${label}: 用户可感指标不得仅以 "${evidence.trim()}" 这类弱证据(测试通过/读源码/跑 demo/种子数据)作为依据 (L15)`,
        );
      }
    }
  });

  // Rule 4 — count consistency / no silent shrink.
  const audited =
    typeof r.audited_metrics_count === "number"
      ? r.audited_metrics_count
      : NaN;
  const predicted =
    typeof r.predicted_metrics_count === "number"
      ? r.predicted_metrics_count
      : NaN;
  if (Number.isNaN(audited)) {
    errors.push("audited_metrics_count 必须是整数");
  }
  if (Number.isNaN(predicted)) {
    errors.push("predicted_metrics_count 必须是整数");
  }
  if (!Number.isNaN(audited) && audited !== metrics.length) {
    errors.push(
      `audited_metrics_count(${audited}) 与 metrics.length(${metrics.length}) 不一致（内部一致性）`,
    );
  }
  if (
    !Number.isNaN(audited) &&
    !Number.isNaN(predicted) &&
    audited < predicted
  ) {
    errors.push(
      `audited_metrics_count(${audited}) < predicted_metrics_count(${predicted})：审计不得静默缩减指标集`,
    );
  }

  // Rule 5 — no bragging text in summary or metric fields.
  if (containsBraggingText(summary)) {
    errors.push("summary 含自我吹嘘措辞（反奉承规则禁止）");
  }
  metrics.forEach((m, i) => {
    const label =
      typeof m?.name === "string" && m.name.trim()
        ? `metric '${m.name}'`
        : `metric[${i}]`;
    const name = typeof m?.name === "string" ? m.name : "";
    const evidence = typeof m?.evidence === "string" ? m.evidence : "";
    if (containsBraggingText(name) || containsBraggingText(evidence)) {
      errors.push(`${label}: 含自我吹嘘措辞（反奉承规则禁止）`);
    }
  });

  // NO_GAPS gate — no discretion.
  if (r.verdict === "NO_GAPS") {
    const unmetP0 = metrics.filter(
      (m) => effectivePriority(m) === "P0" && m?.status !== "MET",
    );
    if (unmetP0.length > 0) {
      const names = unmetP0
        .map((m, i) =>
          typeof m?.name === "string" && m.name.trim() ? m.name : `#${i}`,
        )
        .join(", ");
      errors.push(
        `verdict=NO_GAPS 但存在非 MET 的 P0 指标(${names})——P0 未达成不得判 NO_GAPS，应判 GAPS_FOUND`,
      );
    }
    const blocking = concerns.filter((c) => c?.type === "blocking");
    if (blocking.length > 0) {
      errors.push(
        `verdict=NO_GAPS 但 concerns 含 ${blocking.length} 条 blocking——存在阻塞项不得判 NO_GAPS，应判 GAPS_FOUND`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Cycle persistence + 3-round cap → escalation (pure helpers) ──────────────
//
// The DAG itself is guard-unrolled to 3 audit rounds (workflow-library-seed.ts
// `sdlc-audit`). These helpers are the deterministic bookkeeping the
// orchestrator/brain uses around that loop:
//   - the sprint-level artifact docKey each cycle persists to, and
//   - the 3-round cap decision (a 4th round needed while still GAPS_FOUND
//     escalates to a human gate instead of looping forever).

/** SPRINT-level tracker artifact docKey for a cycle's report (NOT work-item
 *  level). Matches the tracker's `audit-report:{n}` prefix family
 *  (templates/tracker/app/lib/sprint-artifacts.ts classifies it under 验证). */
export function auditReportDocKey(cycle: number): string {
  return `audit-report:${cycle}`;
}

/** The audit loop is capped at 3 rounds. A `cycle` of 4 means a 4th round
 *  WOULD be needed. */
export const AUDIT_MAX_ROUNDS = 3;

/**
 * True when the loop must stop auto-looping and escalate to a human: the next
 * round would exceed the 3-round cap AND the latest verdict is still
 * GAPS_FOUND. Pure — the caller creates the `audit-deferral` approval gate
 * (templates/tracker/actions/request-approval.ts) carrying the accumulated
 * reports.
 */
export function shouldEscalateAudit(args: {
  cycle: number;
  verdict: AuditVerdict;
}): boolean {
  return args.cycle > AUDIT_MAX_ROUNDS && args.verdict === "GAPS_FOUND";
}
