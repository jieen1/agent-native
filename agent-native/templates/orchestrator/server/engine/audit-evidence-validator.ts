// Phase H goal-audit — mechanical anti-flattery evidence validator.
//
// This is the CORE of the Phase H goal-audit work item. It is a pure,
// unit-testable TypeScript module with ZERO runtime dependencies (no ajv, no
// db, no network) so every rule can be exercised directly by vitest.
//
// HOW IT PLUGS INTO THE VALIDATION PATH (mechanical, not prompt-only):
// `v3-dispatcher.ts`'s `classifyOutput()` already runs ajv against a node's
// `output_schema`, and — AFTER ajv passes — calls `isAuditEvidenceSchema()`;
// if the schema carries the `x-audit-evidence: true` marker it calls
// `validateAuditEvidence()` here. Any returned violation turns the node output
// into a `schema-violation` (the same path as a plain ajv failure), which the
// reconciler retries (`retry.on` defaults include "schema-violation") and
// ultimately fails the node on. So these rules are enforced at the SCHEMA
// LAYER — a flattering, evidence-free audit report is rejected mechanically,
// not merely discouraged in the prompt.
//
// The six rules below go BEYOND what plain JSON-Schema can express (format
// alternation on evidence, empty-phrase rejection, cross-field count
// consistency, default-P0 semantics, bragging-text scan, and the userFacing
// runtime-evidence requirement that encodes lesson L15 — the
// desktop-launcher-shipped-on-seed-data incident that took 16 fix PRs).

// ── Types ────────────────────────────────────────────────────────────────────

export type AuditVerdict = "NO_GAPS" | "GAPS_FOUND";
export type MetricStatus = "MET" | "PARTIAL" | "NOT_MET";

export interface RuntimeEvidence {
  entrypoint: string;
  realInput: string;
  capturedOutput: string;
}

export interface AuditMetric {
  name: string;
  /** Optional. ABSENT means P0 (rule 3) — omitting priority cannot dodge the
   * P0 gate. */
  priority?: string;
  status: MetricStatus;
  evidence: string;
  userFacing?: boolean;
  runtimeEvidence?: RuntimeEvidence;
}

export interface AuditConcern {
  type: string; // "blocking" | "non-blocking" | ...
  description: string;
}

export interface AuditReport {
  verdict: AuditVerdict;
  metrics: AuditMetric[];
  audited_metrics_count: number;
  predicted_metrics_count: number;
  concerns: AuditConcern[];
  summary: string;
}

// ── The output_schema (carries the x-audit-evidence marker) ──────────────────
//
// `x-audit-evidence: true` is the marker `isAuditEvidenceSchema()` keys on.
// ajv runs in `strict:false` mode (see v3-dispatcher.ts createAjv), so the
// unknown `x-audit-evidence` keyword is tolerated by ajv and only interpreted
// by us. The plain JSON-Schema part below is the SHAPE gate; the six rules in
// `validateAuditEvidence()` are the SEMANTIC gate that runs after the shape
// passes.

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
          priority: { type: "string" },
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

/** True when this output_schema is a Phase H audit-evidence schema, i.e. it
 * carries the `x-audit-evidence: true` marker. Called by `classifyOutput()`
 * AFTER ajv passes to decide whether to run `validateAuditEvidence()`. */
export function isAuditEvidenceSchema(schema: unknown): boolean {
  return (
    !!schema &&
    typeof schema === "object" &&
    (schema as Record<string, unknown>)["x-audit-evidence"] === true
  );
}

// ── Rule 1 — empty-word rejection ────────────────────────────────────────────
//
// Evidence that is ONLY an empty word carries no information. Rejected when the
// trimmed+lowercased evidence is exactly one of these (Chinese entries are
// unaffected by lowercasing; ✓ is a symbol).

export const EMPTY_EVIDENCE_WORDS: ReadonlySet<string> = new Set([
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

// ── Rule 2 — evidence format alternation ─────────────────────────────────────
//
// Evidence MUST be one of:
//   repo:file[:line]   e.g. packages/core/src/x.ts:42  (a real path w/ ext)
//   PR#<n>             e.g. PR#123
//   <git sha>          7–40 hex chars
//   absence-of:<pat>   e.g. absence-of:seed-data-in-launcher

const EVIDENCE_FILE_RE = /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+(?::[0-9]+)?$/;
const EVIDENCE_PR_RE = /^PR#\d+$/i;
const EVIDENCE_SHA_RE = /^[0-9a-f]{7,40}$/i;
const EVIDENCE_ABSENCE_RE = /^absence-of:.+$/i;

export function isValidEvidenceFormat(evidence: string): boolean {
  const e = evidence.trim();
  return (
    EVIDENCE_FILE_RE.test(e) ||
    EVIDENCE_PR_RE.test(e) ||
    EVIDENCE_SHA_RE.test(e) ||
    EVIDENCE_ABSENCE_RE.test(e)
  );
}

// ── Rule 3 — default P0 ──────────────────────────────────────────────────────

/** A metric with no declared priority is P0 by default, so omitting priority
 * cannot dodge the P0 gate. Normalizes case/whitespace on a declared priority. */
export function effectivePriority(metric: Pick<AuditMetric, "priority">): string {
  const p = metric.priority;
  if (p == null || (typeof p === "string" && p.trim() === "")) return "P0";
  return String(p).trim().toUpperCase();
}

// ── Rule 5 — bragging-text rejection ─────────────────────────────────────────
//
// Self-praise phrases (Chinese + English) are rejected anywhere in summary or
// metric text fields. Case-insensitive for the English entries.

export const BRAGGING_PHRASES: readonly string[] = [
  "圆满完成",
  "超预期",
  "完美",
  "出色完成",
  "mission accomplished",
  "exceeded expectations",
  "flawless",
  "perfectly",
];

function containsBragging(text: string): string | undefined {
  const lower = text.toLowerCase();
  return BRAGGING_PHRASES.find((p) => lower.includes(p.toLowerCase()));
}

// ── Rule 6 — userFacing runtime evidence (lesson L15) ────────────────────────
//
// A user-facing capability metric MUST carry real runtime evidence, not "tests
// pass" / "source reads fine" / "ran the demo" / "seed data". These weak
// phrases are the exact tell-tales of the desktop-launcher-shipped-on-seed-data
// incident (L15, 16 fix PRs).

export const WEAK_USERFACING_EVIDENCE: readonly string[] = [
  "tests pass",
  "test pass",
  "source reads fine",
  "ran the demo",
  "seed data",
];

function isWeakUserFacingEvidence(evidence: string): string | undefined {
  const lower = evidence.toLowerCase();
  return WEAK_USERFACING_EVIDENCE.find((p) => lower.includes(p.toLowerCase()));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// ── The validator ────────────────────────────────────────────────────────────
//
// Returns a list of human-readable violation messages. EMPTY array = the report
// passes all six rules + the NO_GAPS gate. `classifyOutput()` joins these into
// the schema-violation error string.

export function validateAuditEvidence(output: unknown): string[] {
  const violations: string[] = [];
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return ["audit report must be a JSON object"];
  }
  const report = output as Partial<AuditReport>;

  const metrics: AuditMetric[] = Array.isArray(report.metrics)
    ? (report.metrics as AuditMetric[])
    : [];
  const concerns: AuditConcern[] = Array.isArray(report.concerns)
    ? (report.concerns as AuditConcern[])
    : [];
  const summary = typeof report.summary === "string" ? report.summary : "";

  metrics.forEach((metric, i) => {
    const label =
      metric && typeof metric.name === "string" && metric.name.trim()
        ? `metric '${metric.name}'`
        : `metric[${i}]`;
    const rawEvidence =
      metric && typeof metric.evidence === "string" ? metric.evidence : "";
    const evidence = rawEvidence.trim();

    // Rule 1 — non-empty + not an empty word.
    if (evidence === "") {
      violations.push(`${label}: evidence is empty (rule 1)`);
    } else if (EMPTY_EVIDENCE_WORDS.has(evidence.toLowerCase())) {
      violations.push(
        `${label}: evidence '${evidence}' is an empty word, not concrete evidence (rule 1)`,
      );
    }

    // Rule 2 — format alternation.
    if (evidence !== "" && !isValidEvidenceFormat(evidence)) {
      violations.push(
        `${label}: evidence '${evidence}' is not one of repo:file[:line] | PR#<n> | <git sha 7-40> | absence-of:<pattern> (rule 2)`,
      );
    }

    // Rule 5 — bragging text in metric fields.
    const metricBrag =
      containsBragging(typeof metric?.name === "string" ? metric.name : "") ??
      containsBragging(rawEvidence);
    if (metricBrag) {
      violations.push(
        `${label}: bragging text '${metricBrag}' is not allowed in audit output (rule 5)`,
      );
    }

    // Rule 6 — userFacing requires real runtime evidence.
    if (metric && metric.userFacing === true) {
      const re = metric.runtimeEvidence;
      const hasRuntime =
        !!re &&
        typeof re === "object" &&
        isNonEmptyString(re.entrypoint) &&
        isNonEmptyString(re.realInput) &&
        isNonEmptyString(re.capturedOutput);
      if (!hasRuntime) {
        violations.push(
          `${label}: userFacing metric must carry runtimeEvidence with non-empty entrypoint, realInput (non-seed), and capturedOutput (rule 6 / L15)`,
        );
      }
      const weak = isWeakUserFacingEvidence(rawEvidence);
      if (weak) {
        violations.push(
          `${label}: userFacing evidence '${weak}' is not real runtime evidence (rule 6 / L15)`,
        );
      }
    }
  });

  // Rule 4 — count consistency.
  const audited = report.audited_metrics_count;
  const predicted = report.predicted_metrics_count;
  if (typeof audited === "number" && typeof predicted === "number") {
    if (audited < predicted) {
      violations.push(
        `audited_metrics_count (${audited}) < predicted_metrics_count (${predicted}) — the metric set cannot shrink during audit (rule 4)`,
      );
    }
  }
  if (typeof audited === "number" && audited !== metrics.length) {
    violations.push(
      `audited_metrics_count (${audited}) != metrics.length (${metrics.length}) — internal inconsistency (rule 4)`,
    );
  }

  // Rule 5 — bragging text in summary.
  const summaryBrag = containsBragging(summary);
  if (summaryBrag) {
    violations.push(
      `summary: bragging text '${summaryBrag}' is not allowed in audit output (rule 5)`,
    );
  }

  // NO_GAPS gate (STEP 3) — no discretion.
  if (report.verdict === "NO_GAPS") {
    const unmetP0 = metrics.filter(
      (m) => effectivePriority(m) === "P0" && m.status !== "MET",
    );
    for (const m of unmetP0) {
      violations.push(
        `NO_GAPS requires every P0 metric to be MET, but '${m.name}' (${effectivePriority(m)}) is ${m.status} (NO_GAPS gate)`,
      );
    }
    const blocking = concerns.filter((c) => c && c.type === "blocking");
    for (const c of blocking) {
      violations.push(
        `NO_GAPS forbids blocking concerns, found: '${c.description}' (NO_GAPS gate)`,
      );
    }
  }

  return violations;
}
