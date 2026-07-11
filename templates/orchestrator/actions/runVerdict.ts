// runVerdict — F4 (docs/sdlc-impl-f1-f4.md §4A / design 02 §3): the review
// thread's ONLY structured conclusion channel. Writes v3_runs.tags.verdict
// (+ verdictAt / verdictBy) and appends a `review.verdict` v3_events row so
// the verdict lives in the RUN-LEVEL evidence trail the tracker review card
// and backlinks read — not only inside the brain transcript (SDLC-055).
//
// CHANGES_REQUESTED must carry findings; the only remediation exit is a NEW
// workflowRun in fix mode carrying those findings (mechanically enforced by
// the review phase's tool face — no Bash/Edit/Write; see
// server/brain/brain-capability.ts).

import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { getV3Db, resolveOwnerEmail } from "../server/db/index.js";
import { getRequestOrgId } from "@agent-native/core/server/request-context";
import { recordRunVerdict } from "../server/brain/run-verdict.js";

export default defineAction({
  description:
    "Record the independent review verdict for a V3 run (F4 evaluation " +
    "independence). Writes v3_runs.tags.verdict (+verdictAt/verdictBy) and a " +
    "`review.verdict` run event carrying the findings — the run-level " +
    "evidence trail the tracker review card reads. verdict=PASSED approves " +
    "the run's changes; verdict=CHANGES_REQUESTED rejects them and REQUIRES " +
    "findings — the reviewer must then dispatch a NEW workflowRun in fix " +
    "mode carrying those findings (the review session has no write tools " +
    "and never edits code itself). Pass reviewThreadId (your own bt_… " +
    "thread id) so the verdict's provenance is auditable.",
  schema: z
    .object({
      runId: z.string().min(1),
      verdict: z.enum(["PASSED", "CHANGES_REQUESTED"]),
      /** Structured review findings; REQUIRED non-empty for CHANGES_REQUESTED. */
      findings: z.array(z.string().min(1)).default([]),
      /** The reviewing brain thread id (bt_…) recording this verdict. */
      reviewThreadId: z.string().optional(),
    })
    .refine((v) => v.verdict !== "CHANGES_REQUESTED" || v.findings.length > 0, {
      message:
        "CHANGES_REQUESTED requires at least one finding — the findings list is what the fix-mode workflowRun re-dispatch carries.",
      path: ["findings"],
    }),
  http: { method: "POST" },
  audit: {
    target: (args: { runId: string }) => ({
      type: "v3-run",
      id: args.runId,
    }),
    summary: (args: { runId: string; verdict: string }) =>
      `Review verdict ${args.verdict} recorded on run ${args.runId}`,
  },
  run: async (args) => {
    const db = getV3Db();
    return recordRunVerdict(db, {
      runId: args.runId,
      verdict: args.verdict,
      findings: args.findings,
      reviewThreadId: args.reviewThreadId ?? null,
      ownerEmail: resolveOwnerEmail(),
      orgId: getRequestOrgId() ?? null,
    });
  },
});
