// Phase H goal-audit — mechanical anti-flattery evidence validator tests.
//
// Acceptance criteria (work item STEP 5):
//   (A) "Surface-green but real integration defect": tests/validation log all
//       green but the diff has a real integration gap — a userFacing metric
//       whose ONLY evidence is "tests pass" must be REJECTED by rule 6 (the
//       validator does NOT passively trust "tests pass"). A bogus NO_GAPS over
//       it is rejected at the schema layer.
//   (B) "Empty-phrase dodge": a metric whose evidence is 'implemented'/'done'/
//       '✓' must be REJECTED (rules 1 & 2) and concrete evidence required.
// Plus: rule 2 format matrix, rule 3 default-P0, rule 4 count-shrink, rule 5
// bragging, and the NO_GAPS gate (P0-not-MET / blocking-concern).

import { describe, it, expect } from "vitest";

import {
  AUDIT_REPORT_OUTPUT_SCHEMA,
  EMPTY_EVIDENCE_WORDS,
  effectivePriority,
  isAuditEvidenceSchema,
  isValidEvidenceFormat,
  validateAuditEvidence,
  type AuditReport,
} from "./audit-evidence-validator.js";
import { classifyOutput } from "./v3-dispatcher.js";

// A fully-valid report builder. Tests mutate one field at a time so each
// assertion isolates exactly one rule.
function validReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    verdict: "GAPS_FOUND",
    metrics: [
      {
        name: "M1 launcher opens a real file",
        priority: "P0",
        status: "MET",
        evidence: "packages/desktop/src/launcher.ts:88",
        userFacing: true,
        runtimeEvidence: {
          entrypoint: "packages/desktop/src/main.ts",
          realInput: "/home/user/notes/real-note.md",
          capturedOutput: "opened real-note.md (2.1 KB) in editor pane",
        },
      },
    ],
    audited_metrics_count: 1,
    predicted_metrics_count: 1,
    concerns: [],
    summary: "Audited the launcher against the real workspace diff.",
    ...overrides,
  };
}

describe("isAuditEvidenceSchema", () => {
  it("recognizes the x-audit-evidence marker", () => {
    expect(isAuditEvidenceSchema(AUDIT_REPORT_OUTPUT_SCHEMA)).toBe(true);
    expect(isAuditEvidenceSchema({ "x-audit-evidence": true })).toBe(true);
  });
  it("rejects schemas without the marker", () => {
    expect(isAuditEvidenceSchema({ type: "object" })).toBe(false);
    expect(isAuditEvidenceSchema(undefined)).toBe(false);
    expect(isAuditEvidenceSchema(null)).toBe(false);
    expect(isAuditEvidenceSchema("x")).toBe(false);
  });
});

describe("rule 2 — evidence format matrix", () => {
  const accepted = [
    "packages/core/src/x.ts:42",
    "packages/core/src/x.ts",
    "templates/orchestrator/server/engine/audit-evidence-validator.ts:7",
    "PR#123",
    "pr#7",
    "939c567",
    "939c5676a1b2c3d4e5f60718293a4b5c6d7e8f90",
    "absence-of:seed-data-in-launcher",
    "absence-of: hardcoded token",
  ];
  const rejected = [
    "implemented",
    "done",
    "✓",
    "tests pass",
    "looks good",
    "see the diff",
    "PR#",
    "abc", // < 7 hex chars
    "zzzzzzz", // 7 chars but not hex
    "packages/core/src/x", // no file extension
    "",
  ];
  it.each(accepted)("accepts '%s'", (e) => {
    expect(isValidEvidenceFormat(e)).toBe(true);
  });
  it.each(rejected)("rejects '%s'", (e) => {
    expect(isValidEvidenceFormat(e)).toBe(false);
  });
});

describe("rule 3 — default P0 when priority absent", () => {
  it("treats absent/empty priority as P0", () => {
    expect(effectivePriority({})).toBe("P0");
    expect(effectivePriority({ priority: "" })).toBe("P0");
    expect(effectivePriority({ priority: "   " })).toBe("P0");
  });
  it("normalizes a declared priority", () => {
    expect(effectivePriority({ priority: "p1" })).toBe("P1");
    expect(effectivePriority({ priority: "P0" })).toBe("P0");
  });
});

describe("rule 1 — empty-word rejection", () => {
  it("rejects every empty word as the sole evidence", () => {
    for (const word of EMPTY_EVIDENCE_WORDS) {
      const report = validReport({
        metrics: [
          {
            name: "M1",
            priority: "P1",
            status: "MET",
            evidence: word,
          },
        ],
      });
      const v = validateAuditEvidence(report);
      expect(v.some((m) => m.includes("rule 1")), `word '${word}'`).toBe(true);
    }
  });
  it("is case-insensitive and whitespace-trimming", () => {
    const report = validReport({
      metrics: [{ name: "M1", priority: "P1", status: "MET", evidence: "  DONE  " }],
    });
    expect(validateAuditEvidence(report).some((m) => m.includes("rule 1"))).toBe(
      true,
    );
  });
  it("rejects empty evidence", () => {
    const report = validReport({
      metrics: [{ name: "M1", priority: "P1", status: "MET", evidence: "" }],
    });
    expect(validateAuditEvidence(report).some((m) => m.includes("rule 1"))).toBe(
      true,
    );
  });
});

describe("rule 4 — count consistency / no silent shrink", () => {
  it("rejects audited < predicted (metric set shrank)", () => {
    const report = validReport({
      audited_metrics_count: 2,
      predicted_metrics_count: 5,
    });
    // audited(2) != metrics.length(1) also fires; assert the shrink message too.
    const v = validateAuditEvidence(report);
    expect(v.some((m) => m.includes("cannot shrink"))).toBe(true);
  });
  it("rejects audited_metrics_count != metrics.length", () => {
    const report = validReport({ audited_metrics_count: 3 });
    expect(
      validateAuditEvidence(report).some((m) =>
        m.includes("internal inconsistency"),
      ),
    ).toBe(true);
  });
  it("passes when counts are consistent and >= predicted", () => {
    expect(validateAuditEvidence(validReport())).toEqual([]);
  });
});

describe("rule 5 — bragging-text rejection", () => {
  const brags = [
    "圆满完成",
    "超预期",
    "完美",
    "出色完成",
    "Mission Accomplished",
    "exceeded expectations",
    "Flawless",
    "PERFECTLY",
  ];
  it.each(brags)("rejects bragging in summary: '%s'", (b) => {
    const report = validReport({ summary: `Goal ${b}.` });
    expect(validateAuditEvidence(report).some((m) => m.includes("rule 5"))).toBe(
      true,
    );
  });
  it("rejects bragging in a metric field", () => {
    const report = validReport({
      metrics: [
        {
          name: "M1 完美",
          priority: "P1",
          status: "MET",
          evidence: "packages/x/y.ts:1",
        },
      ],
    });
    expect(validateAuditEvidence(report).some((m) => m.includes("rule 5"))).toBe(
      true,
    );
  });
});

describe("rule 6 — userFacing requires real runtime evidence (L15)", () => {
  it("rejects a userFacing metric with no runtimeEvidence", () => {
    const report = validReport({
      metrics: [
        {
          name: "M1",
          priority: "P0",
          status: "MET",
          evidence: "packages/desktop/src/launcher.ts:88",
          userFacing: true,
        },
      ],
    });
    expect(validateAuditEvidence(report).some((m) => m.includes("rule 6"))).toBe(
      true,
    );
  });
  it("rejects runtimeEvidence with an empty field", () => {
    const report = validReport({
      metrics: [
        {
          name: "M1",
          priority: "P0",
          status: "MET",
          evidence: "packages/desktop/src/launcher.ts:88",
          userFacing: true,
          runtimeEvidence: { entrypoint: "main.ts", realInput: "", capturedOutput: "x" },
        },
      ],
    });
    expect(validateAuditEvidence(report).some((m) => m.includes("rule 6"))).toBe(
      true,
    );
  });
  it.each(["tests pass", "source reads fine", "ran the demo", "seed data"])(
    "rejects weak userFacing evidence '%s' even with runtimeEvidence present",
    (weak) => {
      const report = validReport({
        metrics: [
          {
            name: "M1",
            priority: "P0",
            status: "MET",
            evidence: weak,
            userFacing: true,
            runtimeEvidence: {
              entrypoint: "main.ts",
              realInput: "real.md",
              capturedOutput: "ok",
            },
          },
        ],
      });
      expect(
        validateAuditEvidence(report).some((m) => m.includes("rule 6")),
      ).toBe(true);
    },
  );
  it("accepts a userFacing metric with full real runtime evidence", () => {
    expect(validateAuditEvidence(validReport())).toEqual([]);
  });
});

describe("NO_GAPS gate — no discretion", () => {
  it("rejects NO_GAPS when a P0 metric is not MET", () => {
    const report = validReport({
      verdict: "NO_GAPS",
      metrics: [
        {
          name: "M1",
          priority: "P0",
          status: "PARTIAL",
          evidence: "packages/x/y.ts:1",
        },
      ],
    });
    expect(
      validateAuditEvidence(report).some((m) => m.includes("NO_GAPS gate")),
    ).toBe(true);
  });
  it("rejects NO_GAPS when a priority-ABSENT (default P0) metric is not MET", () => {
    const report = validReport({
      verdict: "NO_GAPS",
      metrics: [
        { name: "M1", status: "NOT_MET", evidence: "packages/x/y.ts:1" },
      ],
    });
    expect(
      validateAuditEvidence(report).some((m) => m.includes("NO_GAPS gate")),
    ).toBe(true);
  });
  it("rejects NO_GAPS when a blocking concern exists", () => {
    const report = validReport({
      verdict: "NO_GAPS",
      concerns: [{ type: "blocking", description: "launcher crashes on real file" }],
    });
    expect(
      validateAuditEvidence(report).some((m) => m.includes("NO_GAPS gate")),
    ).toBe(true);
  });
  it("allows NO_GAPS when all P0 MET and no blocking concern", () => {
    const report = validReport({
      verdict: "NO_GAPS",
      concerns: [{ type: "non-blocking", description: "minor naming nit" }],
    });
    expect(validateAuditEvidence(report)).toEqual([]);
  });
  it("does NOT apply the NO_GAPS gate to a GAPS_FOUND verdict", () => {
    const report = validReport({
      verdict: "GAPS_FOUND",
      metrics: [{ name: "M1", priority: "P0", status: "NOT_MET", evidence: "packages/x/y.ts:1" }],
    });
    expect(
      validateAuditEvidence(report).some((m) => m.includes("NO_GAPS gate")),
    ).toBe(false);
  });
});

describe("acceptance (B) — empty-phrase dodge is rejected at the schema layer", () => {
  it.each(["implemented", "done", "✓"])(
    "a metric whose only evidence is '%s' is rejected",
    (word) => {
      const report = validReport({
        metrics: [{ name: "M1", priority: "P1", status: "MET", evidence: word }],
      });
      const v = validateAuditEvidence(report);
      expect(v.length).toBeGreaterThan(0);
      expect(v.some((m) => m.includes("rule 1") || m.includes("rule 2"))).toBe(
        true,
      );
    },
  );
});

describe("acceptance (A) — surface-green but real integration defect", () => {
  // The diff has a real integration gap (launcher only wired to seed data);
  // the validation log is all green. The auditor tries to pass it off as
  // userFacing-MET with only "tests pass" as evidence and a bogus NO_GAPS.
  it("rejects a userFacing metric whose only evidence is 'tests pass' (rule 6)", () => {
    const bogusGreenReport = validReport({
      verdict: "NO_GAPS",
      metrics: [
        {
          name: "M1 desktop launcher opens user files",
          priority: "P0",
          status: "MET",
          evidence: "tests pass", // ← surface green, no real runtime evidence
          userFacing: true,
        },
      ],
    });
    const v = validateAuditEvidence(bogusGreenReport);
    // Rule 6 fires (no runtimeEvidence + weak "tests pass" evidence).
    expect(v.some((m) => m.includes("rule 6"))).toBe(true);
    // And the bogus NO_GAPS is rejected: P0 is not genuinely MET with real
    // evidence — the report cannot pass the schema layer as-is.
    expect(v.length).toBeGreaterThan(0);
  });

  it("a correct GAPS_FOUND report for the same defect passes the validator", () => {
    const honestReport = validReport({
      verdict: "GAPS_FOUND",
      metrics: [
        {
          name: "M1 desktop launcher opens user files",
          priority: "P0",
          status: "NOT_MET",
          evidence: "absence-of:real-file-open-in-launcher",
          userFacing: true,
          runtimeEvidence: {
            entrypoint: "packages/desktop/src/main.ts",
            realInput: "/home/user/notes/real-note.md",
            capturedOutput: "launcher opened seed sample, ignored the real file",
          },
        },
      ],
      concerns: [
        {
          type: "blocking",
          description: "launcher only opens bundled seed data, not real user files",
        },
      ],
      summary: "Integration gap: launcher wired to seed data only.",
    });
    expect(validateAuditEvidence(honestReport)).toEqual([]);
  });
});

describe("end-to-end — classifyOutput rejects a flattering report at the schema layer", () => {
  it("returns schema-violation for an empty-word report, object for a clean one", () => {
    const flattering = validReport({
      metrics: [{ name: "M1", priority: "P1", status: "MET", evidence: "done" }],
    });
    const bad = classifyOutput(
      JSON.stringify(flattering),
      AUDIT_REPORT_OUTPUT_SCHEMA,
    );
    expect(bad.path).toBe("schema-violation");
    if (bad.path === "schema-violation") {
      expect(bad.error).toContain("Audit evidence validation failed");
    }

    const clean = classifyOutput(
      JSON.stringify(validReport()),
      AUDIT_REPORT_OUTPUT_SCHEMA,
    );
    expect(clean.path).toBe("object");
  });

  it("still rejects a bogus NO_GAPS over a green-but-defective userFacing metric", () => {
    const bogus = validReport({
      verdict: "NO_GAPS",
      metrics: [
        {
          name: "M1",
          priority: "P0",
          status: "MET",
          evidence: "tests pass",
          userFacing: true,
        },
      ],
    });
    const result = classifyOutput(
      JSON.stringify(bogus),
      AUDIT_REPORT_OUTPUT_SCHEMA,
    );
    expect(result.path).toBe("schema-violation");
  });
});
