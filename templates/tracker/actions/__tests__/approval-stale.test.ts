import { describe, expect, it } from "vitest";

import {
  ApprovalRow,
  isApprovalActiveApproved,
  selectApprovalsToStale,
  buildReconfirmationApprovalInput,
} from "../create-sprint-artifact.js";

// ============================================================================
// Tests for isApprovalActiveApproved
// ============================================================================

describe("isApprovalActiveApproved", () => {
  it('returns true when status="approved" and staleAt=null', () => {
    expect(
      isApprovalActiveApproved({ status: "approved", staleAt: null }),
    ).toBe(true);
  });

  it('returns false when status="approved" but staleAt is non-null', () => {
    expect(
      isApprovalActiveApproved({
        status: "approved",
        staleAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
  });

  it('returns false when status="pending"', () => {
    expect(isApprovalActiveApproved({ status: "pending", staleAt: null })).toBe(
      false,
    );
  });

  it('returns false when status="rejected"', () => {
    expect(
      isApprovalActiveApproved({ status: "rejected", staleAt: null }),
    ).toBe(false);
  });

  it('returns false when status="rejected" and staleAt is non-null', () => {
    expect(
      isApprovalActiveApproved({
        status: "rejected",
        staleAt: "2026-01-01T00:00:00Z",
      }),
    ).toBe(false);
  });
});

// ============================================================================
// Tests for selectApprovalsToStale
// ============================================================================

describe("selectApprovalsToStale", () => {
  function makeApproval(override: Partial<ApprovalRow> = {}): ApprovalRow {
    return {
      id: "a1",
      sprintId: "s1",
      workItemId: "w1",
      gateKey: "plan-signoff",
      status: "approved",
      requestedBy: "alice@example.com",
      anchorArtifactId: "art_v1",
      anchorVersion: 1,
      staleAt: null,
      ...override,
    };
  }

  it("selects an approved approval anchored to an old artifact id with staleAt=null", () => {
    const approvals = [makeApproval({ id: "a1", anchorArtifactId: "art_v1" })];
    const result = selectApprovalsToStale(approvals, ["art_v1"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a1");
  });

  it("does NOT select an approved approval whose anchorArtifactId is not in oldArtifactIds", () => {
    const approvals = [
      makeApproval({ id: "a1", anchorArtifactId: "art_other" }),
    ];
    const result = selectApprovalsToStale(approvals, ["art_v1"]);
    expect(result).toHaveLength(0);
  });

  it("does NOT select an already-staled approval (idempotent)", () => {
    const approvals = [
      makeApproval({
        id: "a1",
        anchorArtifactId: "art_v1",
        staleAt: "2026-01-01T00:00:00Z",
      }),
    ];
    const result = selectApprovalsToStale(approvals, ["art_v1"]);
    expect(result).toHaveLength(0);
  });

  it("does NOT select a pending approval even if anchorArtifactId matches", () => {
    const approvals = [
      makeApproval({ id: "a1", anchorArtifactId: "art_v1", status: "pending" }),
    ];
    const result = selectApprovalsToStale(approvals, ["art_v1"]);
    expect(result).toHaveLength(0);
  });

  it("does NOT select an approval with anchorArtifactId=null (unanchored)", () => {
    const approvals = [makeApproval({ id: "a1", anchorArtifactId: null })];
    const result = selectApprovalsToStale(approvals, ["art_v1"]);
    expect(result).toHaveLength(0);
  });

  it("correctly filters a mixed batch — only the qualifying ones are returned", () => {
    const approvals: ApprovalRow[] = [
      // Should be selected
      makeApproval({
        id: "a-qual",
        anchorArtifactId: "art_old",
        status: "approved",
        staleAt: null,
      }),
      // Not anchored
      makeApproval({ id: "a-no-anchor", anchorArtifactId: null }),
      // Already stale
      makeApproval({
        id: "a-already-stale",
        anchorArtifactId: "art_old",
        staleAt: "2026-01-01T00:00:00Z",
      }),
      // Wrong anchor
      makeApproval({ id: "a-wrong-anchor", anchorArtifactId: "art_unrelated" }),
      // Pending
      makeApproval({
        id: "a-pending",
        anchorArtifactId: "art_old",
        status: "pending",
      }),
    ];
    const result = selectApprovalsToStale(approvals, ["art_old"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a-qual");
  });
});

// ============================================================================
// Tests for buildReconfirmationApprovalInput
// ============================================================================

describe("buildReconfirmationApprovalInput", () => {
  it("returns a pending reconfirmation with correct fields", () => {
    const staleApproval = {
      sprintId: "s1",
      workItemId: "w1",
      gateKey: "plan-signoff",
      requestedBy: "a@x.com",
    };
    const newArtifact = {
      id: "art_v2",
      docKey: "sprint-doc",
      version: 2,
    };

    const result = buildReconfirmationApprovalInput(staleApproval, newArtifact);

    expect(result.status).toBe("pending");
    expect(result.gateKey).toBe("plan-signoff");
    expect(result.workItemId).toBe("w1");
    expect(result.sprintId).toBe("s1");
    expect(result.requestedBy).toBe("a@x.com");
    expect(result.anchorArtifactId).toBe("art_v2");
    expect(result.anchorVersion).toBe(2);
    expect(result.reason).toContain("sprint-doc");
    expect(result.reason).toContain("v2");
  });

  it("preserves null workItemId for sprint-level approvals", () => {
    const staleApproval = {
      sprintId: "s1",
      workItemId: null,
      gateKey: "escalation",
      requestedBy: "admin@x.com",
    };
    const newArtifact = {
      id: "art_new",
      docKey: "audit-report",
      version: 3,
    };

    const result = buildReconfirmationApprovalInput(staleApproval, newArtifact);

    expect(result.workItemId).toBeNull();
    expect(result.gateKey).toBe("escalation");
    expect(result.reason).toContain("audit-report");
    expect(result.reason).toContain("v3");
  });

  it('reason format matches "重确认：<docKey> v<version>"', () => {
    const staleApproval = {
      sprintId: "s1",
      workItemId: "w1",
      gateKey: "design-signoff",
      requestedBy: "bob@x.com",
    };
    const newArtifact = {
      id: "art_3",
      docKey: "tech-design",
      version: 5,
    };

    const result = buildReconfirmationApprovalInput(staleApproval, newArtifact);

    expect(result.reason).toBe("重确认：tech-design v5");
  });
});
