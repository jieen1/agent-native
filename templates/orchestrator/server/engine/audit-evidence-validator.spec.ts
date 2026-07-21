/**
 * Phase H goal-audit — anti-flattery evidence validator tests.
 *
 * Covers the six mechanical rules + the NO_GAPS gate + cycle/escalation
 * helpers, plus end-to-end wiring through `classifyOutput` (the real
 * output_schema validation path in v3-dispatcher.ts).
 */
import { describe, it, expect } from "vitest";

import {
  validateAuditReport,
  isEmptyEvidencePhrase,
  isValidEvidenceFormat,
  effectivePriority,
  containsBraggingText,
  isWeakUserFacingEvidence,
  hasRealRuntimeEvidence,
  isAuditEvidenceSchema,
  auditReportDocKey,
  shouldEscalateAudit,
  AUDIT_MAX_ROUNDS,
  AUDIT_REPORT_OUTPUT_SCHEMA,
  type AuditMetric,
} from "./audit-evidence-validator.js";
import { classifyOutput } from "./v3-dispatcher.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid audit report that passes all six rules. */
function validReport(overrides: Record<string, unknown> = {}) {
  return {
    verdict: "NO_GAPS",
    metrics: [
      {
        name: "search returns results",
        priority: "P0",
        status: "MET",
        evidence: "packages/core/src/search.ts:42",
      },
    ],
    audited_metrics_count: 1,
    predicted_metrics_count: 1,
    concerns: [],
    summary: "Goal met with concrete evidence.",
    ...overrides,
  };
}

// ── Rule 1 — empty-word rejection ────────────────────────────────────────────

describe("Rule 1 — empty-word rejection", () => {
  const EMPTY_WORDS = [
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
  ];

  it.each(EMPTY_WORDS)("isEmptyEvidencePhrase rejects '%s'", (word) => {
    expect(isEmptyEvidencePhrase(word)).toBe(true);
    // Also with surrounding whitespace / mixed case
    expect(isEmptyEvidencePhrase(`  ${word.toUpperCase()}  `)).toBe(true);
  });

  it("accepts non-empty-phrase evidence", () => {
    expect(isEmptyEvidencePhrase("packages/core/src/x.ts:42")).toBe(false);
    expect(isEmptyEvidencePhrase("PR#123")).toBe(false);
    expect(isEmptyEvidencePhrase("absence-of:TODO")).toBe(false);
  });

  it("validateAuditReport rejects a metric whose evidence is an empty phrase", () => {
    const report = validReport({
      metrics: [
        {
          name: "feature X",
          priority: "P0",
          status: "MET",
          evidence: "done",
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("空话"))).toBe(true);
  });

  it("validateAuditReport rejects empty-string evidence", () => {
    const report = validReport({
      metrics: [{ name: "m", priority: "P0", status: "MET", evidence: "   " }],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("为空"))).toBe(true);
  });
});

// ── Rule 2 — evidence format ─────────────────────────────────────────────────

describe("Rule 2 — evidence format acceptance/rejection matrix", () => {
  const ACCEPTED = [
    "packages/core/src/x.ts:42",
    "src/index.ts",
    "a/b/c.ts:1",
    "PR#123",
    "PR#1",
    "abc1234",
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", // 40 hex
    "absence-of:TODO",
    "absence-of:console.log",
  ];

  const REJECTED = [
    "tests pass",
    "looks good",
    "x.ts", // bare filename, no path slash
    "implemented",
    "done",
    "✓",
    "all good",
    "PR#", // no number
    "abc", // too short for sha (< 7)
    "xyzxyzxyz", // 9 chars but not hex
    "",
    "   ",
    "defaced", // 7 hex chars but all-letter — dictionary word bypass (Finding 1)
    "effaced", // 7 hex chars but all-letter — dictionary word bypass (Finding 1)
    "deadbeef", // 8 hex chars but all-letter — another common hex word
    "facade", // 6 hex chars — too short AND all-letter
  ];

  it.each(ACCEPTED)("accepts '%s'", (evidence) => {
    expect(isValidEvidenceFormat(evidence)).toBe(true);
  });

  it.each(REJECTED)("rejects '%s'", (evidence) => {
    expect(isValidEvidenceFormat(evidence)).toBe(false);
  });

  it("validateAuditReport rejects bad-format evidence", () => {
    const report = validReport({
      metrics: [
        { name: "m", priority: "P0", status: "MET", evidence: "looks good" },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("格式非法"))).toBe(true);
  });

  // Finding 1 regression: dictionary words that happen to be all-hex must NOT pass
  it("rejects 'defaced' as evidence (pure hex letters, no digits)", () => {
    expect(isValidEvidenceFormat("defaced")).toBe(false);
  });

  it("rejects 'effaced' as evidence (pure hex letters, no digits)", () => {
    expect(isValidEvidenceFormat("effaced")).toBe(false);
  });

  it("rejects a bragging sentence that merely CONTAINS a 7-char hex token (Finding 1)", () => {
    // The whole string is not a valid evidence format even though it contains
    // the hex token "abc1234" — the anchored check rejects it.
    expect(isValidEvidenceFormat("we did abc1234 which is great")).toBe(false);
    // validateAuditReport must also reject it
    const report = validReport({
      metrics: [
        {
          name: "m",
          priority: "P0",
          status: "MET",
          evidence: "we did abc1234 which is great",
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("格式非法"))).toBe(true);
  });
});

// ── Rule 3 — default P0 ──────────────────────────────────────────────────────

describe("Rule 3 — default P0 when priority absent", () => {
  it("effectivePriority returns P0 when priority is undefined", () => {
    expect(effectivePriority({ name: "x" })).toBe("P0");
    expect(effectivePriority({ name: "x", priority: undefined })).toBe("P0");
    expect(effectivePriority({ name: "x", priority: null })).toBe("P0");
    expect(effectivePriority({ name: "x", priority: "garbage" })).toBe("P0");
  });

  it("effectivePriority respects declared P1/P2", () => {
    expect(effectivePriority({ priority: "P1" } as AuditMetric)).toBe("P1");
    expect(effectivePriority({ priority: "P2" } as AuditMetric)).toBe("P2");
    expect(effectivePriority({ priority: "P0" } as AuditMetric)).toBe("P0");
  });

  it("NO_GAPS gate applies P0 semantics to priority-absent metrics", () => {
    // A metric with NO priority and status NOT_MET → should block NO_GAPS
    const report = validReport({
      verdict: "NO_GAPS",
      metrics: [
        {
          name: "no-priority metric",
          // priority deliberately omitted
          status: "PARTIAL",
          evidence: "packages/core/src/x.ts:1",
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("P0"))).toBe(true);
  });
});

// ── Rule 4 — count consistency / no silent shrink ────────────────────────────

describe("Rule 4 — audited_metrics_count consistency", () => {
  it("rejects when audited < predicted (silent shrink)", () => {
    const report = validReport({
      audited_metrics_count: 1,
      predicted_metrics_count: 3,
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("缩减指标集"))).toBe(true);
  });

  it("rejects when audited_metrics_count != metrics.length", () => {
    const report = validReport({
      audited_metrics_count: 5,
      predicted_metrics_count: 1,
      // metrics array has 1 entry but count says 5
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("不一致"))).toBe(true);
  });

  it("passes when counts are consistent and audited >= predicted", () => {
    const report = validReport({
      audited_metrics_count: 1,
      predicted_metrics_count: 1,
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(true);
  });
});

// ── Rule 5 — bragging-text rejection ─────────────────────────────────────────

describe("Rule 5 — bragging-text rejection", () => {
  const BRAGGING = [
    "圆满完成",
    "超预期",
    "完美",
    "出色完成",
    "mission accomplished",
    "exceeded expectations",
    "flawless",
    "perfectly",
    "Mission Accomplished", // case-insensitive
    "FLAWLESS execution",
  ];

  it.each(BRAGGING)("containsBraggingText detects '%s'", (phrase) => {
    expect(containsBraggingText(phrase)).toBe(true);
    expect(containsBraggingText(`We achieved ${phrase} today`)).toBe(true);
  });

  it("does not false-positive on normal text", () => {
    expect(containsBraggingText("Goal met with evidence.")).toBe(false);
    expect(containsBraggingText("All P0 metrics verified.")).toBe(false);
  });

  it("validateAuditReport rejects bragging in summary", () => {
    const report = validReport({ summary: "圆满完成 all goals" });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("吹嘘"))).toBe(true);
  });

  it("validateAuditReport rejects bragging in metric name/evidence", () => {
    const report = validReport({
      metrics: [
        {
          name: "flawless search",
          priority: "P0",
          status: "MET",
          evidence: "packages/core/src/x.ts:1",
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("吹嘘"))).toBe(true);
  });
});

// ── Rule 6 — user-facing runtime evidence (L15) ──────────────────────────────

describe("Rule 6 — userFacing metrics require real runtime evidence", () => {
  it("rejects userFacing metric with no runtimeEvidence", () => {
    const report = validReport({
      metrics: [
        {
          name: "desktop launcher opens",
          priority: "P0",
          status: "MET",
          evidence: "packages/app/src/launcher.ts:10",
          userFacing: true,
          // runtimeEvidence deliberately missing
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("真实运行证据"))).toBe(true);
  });

  it("rejects userFacing metric with incomplete runtimeEvidence (missing capturedOutput)", () => {
    const report = validReport({
      metrics: [
        {
          name: "desktop launcher opens",
          priority: "P0",
          status: "MET",
          evidence: "packages/app/src/launcher.ts:10",
          userFacing: true,
          runtimeEvidence: {
            entrypoint: "./run.sh",
            realInput: "user-project/",
            // capturedOutput missing
          },
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
  });

  it("rejects weak evidence phrases for userFacing metrics", () => {
    const WEAK = [
      "tests pass",
      "all tests passed",
      "source reads fine",
      "ran the demo",
      "seed data",
      "Tests Pass with flying colors",
    ];
    for (const w of WEAK) {
      expect(isWeakUserFacingEvidence(w)).toBe(true);
    }
  });

  // Finding 3 — explicit validateAuditReport rejection for each L15 lesson phrase
  // as the SOLE evidence for a userFacing metric (not just the helper function).
  it.each([
    ["tests pass", "L15: 'tests pass' is not proof a real user can use the feature"],
    ["ran the demo", "L15: 'ran the demo' is not proof of real user capability"],
    ["seed data", "L15: 'seed data' is not proof of real user capability"],
  ])(
    "validateAuditReport rejects '%s' as sole evidence for userFacing metric (L15 regression)",
    (weakEvidence) => {
      const report = {
        verdict: "GAPS_FOUND",
        metrics: [
          {
            name: "user-facing capability",
            priority: "P0",
            status: "MET",
            evidence: weakEvidence,
            userFacing: true,
            // No runtimeEvidence — the combination of weak evidence + missing
            // runtimeEvidence must be caught by rule 6.
          },
        ],
        audited_metrics_count: 1,
        predicted_metrics_count: 1,
        concerns: [],
        summary: "Seemed fine.",
      };
      const result = validateAuditReport(report);
      expect(result.ok).toBe(false);
      // Must fire at least the rule-6 weak-evidence error
      expect(
        result.errors.some(
          (e) => e.includes("弱证据") || e.includes("真实运行证据"),
        ),
      ).toBe(true);
    },
  );

  it("accepts a userFacing metric with full runtimeEvidence and strong evidence format", () => {
    const report = validReport({
      metrics: [
        {
          name: "desktop launcher opens",
          priority: "P0",
          status: "MET",
          evidence: "packages/app/src/launcher.ts:10",
          userFacing: true,
          runtimeEvidence: {
            entrypoint: "./bin/launcher --open",
            realInput: "/home/user/real-project",
            capturedOutput: "Window opened: 1920x1080, title='real-project'",
          },
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(true);
  });

  it("hasRealRuntimeEvidence rejects empty-string fields", () => {
    expect(
      hasRealRuntimeEvidence({
        entrypoint: "",
        realInput: "x",
        capturedOutput: "y",
      }),
    ).toBe(false);
    expect(
      hasRealRuntimeEvidence({
        entrypoint: "x",
        realInput: "  ",
        capturedOutput: "y",
      }),
    ).toBe(false);
    expect(hasRealRuntimeEvidence(null)).toBe(false);
    expect(hasRealRuntimeEvidence("string")).toBe(false);
  });
});

// ── NO_GAPS gate — no discretion ─────────────────────────────────────────────

describe("NO_GAPS gate", () => {
  it("rejects NO_GAPS when a P0 metric is not MET", () => {
    const report = validReport({
      verdict: "NO_GAPS",
      metrics: [
        {
          name: "core feature",
          priority: "P0",
          status: "NOT_MET",
          evidence: "packages/core/src/x.ts:1",
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("P0 未达成"))).toBe(true);
  });

  it("rejects NO_GAPS when a P0 metric is PARTIAL", () => {
    const report = validReport({
      verdict: "NO_GAPS",
      metrics: [
        {
          name: "core feature",
          priority: "P0",
          status: "PARTIAL",
          evidence: "packages/core/src/x.ts:1",
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
  });

  it("rejects NO_GAPS when concerns contain a blocking item", () => {
    const report = validReport({
      verdict: "NO_GAPS",
      concerns: [
        { type: "blocking", description: "data loss risk on migration" },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("blocking"))).toBe(true);
  });

  it("allows NO_GAPS when all P0 are MET and no blocking concerns", () => {
    const report = validReport({
      verdict: "NO_GAPS",
      concerns: [{ type: "non-blocking", description: "minor style nit" }],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(true);
  });

  it("allows GAPS_FOUND even with unmet P0 (that's the correct verdict)", () => {
    const report = validReport({
      verdict: "GAPS_FOUND",
      metrics: [
        {
          name: "core feature",
          priority: "P0",
          status: "NOT_MET",
          evidence: "packages/core/src/x.ts:1",
        },
      ],
    });
    const result = validateAuditReport(report);
    expect(result.ok).toBe(true);
  });
});

// ── Scenario A: surface-green but real integration defect (L15) ──────────────

describe("Scenario A — surface-green but real integration defect", () => {
  it("rejects a bogus NO_GAPS where userFacing metric's only evidence is 'tests pass'", () => {
    // The validation log is all green, but the metric is user-facing and has
    // no real runtime evidence — the validator must NOT passively trust it.
    const bogusReport = {
      verdict: "NO_GAPS",
      metrics: [
        {
          name: "desktop launcher opens real projects",
          priority: "P0",
          status: "MET",
          evidence: "tests pass",
          userFacing: true,
          // no runtimeEvidence — only "tests pass"
        },
      ],
      audited_metrics_count: 1,
      predicted_metrics_count: 1,
      concerns: [],
      summary: "All green.",
    };
    const result = validateAuditReport(bogusReport);
    expect(result.ok).toBe(false);
    // Multiple rules fire: rule 1/2 (bad evidence format) + rule 6 (weak
    // userFacing evidence + missing runtimeEvidence).
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("produces GAPS_FOUND (passes validation) when the auditor correctly flags the gap", () => {
    const correctReport = {
      verdict: "GAPS_FOUND",
      metrics: [
        {
          name: "desktop launcher opens real projects",
          priority: "P0",
          status: "NOT_MET",
          evidence: "absence-of:launcher-integration-test",
          userFacing: true,
          runtimeEvidence: {
            entrypoint: "./bin/launcher --open",
            realInput: "/home/user/real-project",
            capturedOutput: "ERROR: cannot open — seed data path hardcoded",
          },
        },
      ],
      audited_metrics_count: 1,
      predicted_metrics_count: 1,
      concerns: [
        {
          type: "blocking",
          description:
            "Launcher only works with seed data; real user projects fail.",
        },
      ],
      summary:
        "Integration gap: launcher hardcodes seed path. See absence-of evidence.",
    };
    const result = validateAuditReport(correctReport);
    expect(result.ok).toBe(true);
  });
});

// ── Scenario B: empty-phrase dodge ───────────────────────────────────────────

describe("Scenario B — empty-phrase dodge", () => {
  it.each(["implemented", "done", "✓"])(
    "rejects evidence '%s' and requires concrete evidence",
    (phrase) => {
      const report = validReport({
        metrics: [
          {
            name: "feature",
            priority: "P0",
            status: "MET",
            evidence: phrase,
          },
        ],
      });
      const result = validateAuditReport(report);
      expect(result.ok).toBe(false);
      // Must mention the empty-phrase or format rejection
      expect(
        result.errors.some((e) => e.includes("空话") || e.includes("格式非法")),
      ).toBe(true);
    },
  );
});

// ── Cycle persistence + escalation helpers ───────────────────────────────────

describe("Cycle persistence + 3-round cap helpers", () => {
  it("auditReportDocKey produces sprint-level artifact keys", () => {
    expect(auditReportDocKey(1)).toBe("audit-report:1");
    expect(auditReportDocKey(2)).toBe("audit-report:2");
    expect(auditReportDocKey(3)).toBe("audit-report:3");
  });

  it("AUDIT_MAX_ROUNDS is 3", () => {
    expect(AUDIT_MAX_ROUNDS).toBe(3);
  });

  it("shouldEscalateAudit is false for cycles 1-3 regardless of verdict", () => {
    for (const cycle of [1, 2, 3]) {
      expect(shouldEscalateAudit({ cycle, verdict: "GAPS_FOUND" })).toBe(false);
      expect(shouldEscalateAudit({ cycle, verdict: "NO_GAPS" })).toBe(false);
    }
  });

  it("shouldEscalateAudit is true at cycle 4 with GAPS_FOUND", () => {
    expect(shouldEscalateAudit({ cycle: 4, verdict: "GAPS_FOUND" })).toBe(true);
  });

  it("shouldEscalateAudit is false at cycle 4 with NO_GAPS (resolved)", () => {
    expect(shouldEscalateAudit({ cycle: 4, verdict: "NO_GAPS" })).toBe(false);
  });
});

// ── isAuditEvidenceSchema marker ─────────────────────────────────────────────

describe("isAuditEvidenceSchema", () => {
  it("recognizes the AUDIT_REPORT_OUTPUT_SCHEMA marker", () => {
    expect(isAuditEvidenceSchema(AUDIT_REPORT_OUTPUT_SCHEMA)).toBe(true);
  });

  it("rejects schemas without the marker", () => {
    expect(isAuditEvidenceSchema({ type: "object" })).toBe(false);
    expect(isAuditEvidenceSchema(null)).toBe(false);
    expect(isAuditEvidenceSchema(undefined)).toBe(false);
    expect(isAuditEvidenceSchema("string")).toBe(false);
  });
});

// ── End-to-end: classifyOutput wiring ────────────────────────────────────────

describe("classifyOutput integration — audit schema enforcement", () => {
  it("accepts a valid audit report through the real validation path", () => {
    const report = validReport();
    const result = classifyOutput(
      JSON.stringify(report),
      AUDIT_REPORT_OUTPUT_SCHEMA,
    );
    expect(result.path).toBe("object");
  });

  it("rejects an empty-phrase audit report as schema-violation (not object)", () => {
    const bogus = validReport({
      metrics: [{ name: "m", priority: "P0", status: "MET", evidence: "done" }],
    });
    const result = classifyOutput(
      JSON.stringify(bogus),
      AUDIT_REPORT_OUTPUT_SCHEMA,
    );
    expect(result.path).toBe("schema-violation");
    if (result.path === "schema-violation") {
      expect(result.error).toContain("anti-flattery");
    }
  });

  it("rejects a bogus NO_GAPS (P0 not MET) as schema-violation", () => {
    const bogus = validReport({
      verdict: "NO_GAPS",
      metrics: [
        {
          name: "core",
          priority: "P0",
          status: "NOT_MET",
          evidence: "packages/core/src/x.ts:1",
        },
      ],
    });
    const result = classifyOutput(
      JSON.stringify(bogus),
      AUDIT_REPORT_OUTPUT_SCHEMA,
    );
    expect(result.path).toBe("schema-violation");
  });

  it("rejects a userFacing metric with only 'tests pass' evidence (L15 scenario)", () => {
    const bogus = {
      verdict: "GAPS_FOUND",
      metrics: [
        {
          name: "launcher works",
          priority: "P0",
          status: "MET",
          evidence: "tests pass",
          userFacing: true,
        },
      ],
      audited_metrics_count: 1,
      predicted_metrics_count: 1,
      concerns: [],
      summary: "Looks fine.",
    };
    const result = classifyOutput(
      JSON.stringify(bogus),
      AUDIT_REPORT_OUTPUT_SCHEMA,
    );
    expect(result.path).toBe("schema-violation");
  });
});
