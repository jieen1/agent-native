---
name: sprint-recap
description: >-
  Post-sprint retrospective that derives a human-intervention timeline strictly
  from real records: approval records, comments, manual re-dispatch and rollback
  operations. Each timeline entry cites its source record. Explicitly forbids
  fabricating entries; if there are no interventions, say so. Use after a sprint
  reaches "已完成" or "已发布" status to understand where humans had to step in.
scope: dev
metadata:
  internal: true
---

# Sprint Recap — Human-Intervention Timeline

After a sprint is delivered, produce a retrospective that answers: **where did
humans have to intervene, and why?** The answer must come strictly from real
records in the tracker database — never fabricated, never inferred from code
comments or commit messages.

## Why this matters

The agent-native SDLC system is designed to minimize human intervention, but
some interventions are necessary (approvals, course corrections, rollbacks).
Understanding where and why humans intervened reveals:

- Which gates are working (catching real issues before they ship).
- Which workflows need improvement (repeated manual fixes suggest automation
  gaps).
- Whether the sprint's "autonomy" claim is honest (a sprint with 15 manual
  rollbacks is not autonomous, even if it shipped).

## Process

### 1. Query the real intervention records

For the sprint's work items, query:

- **Approvals** (`tracker_approvals`): every `request-approval` /
  `approve-gate` / `reject-gate` action. Each approval is a human decision
  point.
- **Comments** (`tracker_comments`): human-authored comments (actorKind =
  "human") on work items. These often explain *why* a human intervened.
- **Stage rollbacks** (`tracker_stages` where `stageStatus = "已驳回"`):
  manual rejections that sent work back to an earlier stage.
- **Manual re-dispatches** (`tracker_work_item_runs` where `superseded = 1`):
  a work item was dispatched, then re-dispatched (the first run was superseded).
  This often means the first attempt failed or was wrong.

### 2. Build the timeline

For each intervention, record:

- **When**: the timestamp (from the record's `createdAt` / `decidedAt` /
  `updatedAt`).
- **What**: the action (approval requested, approval granted, approval
  rejected, comment added, stage rolled back, work re-dispatched).
- **Who**: the actor (from `requestedBy` / `decidedBy` / `actorName`).
- **Why**: the reason (from `reason` / comment text / verdict reason).
- **Source**: the exact record id (e.g. `approval:apr_abc123`,
  `comment:cmt_def456`, `stage:stg_ghi789`).

Order the timeline chronologically.

### 3. Categorize interventions

Group the timeline into:

- **Approvals** (expected human checkpoints — plan-signoff, ui-signoff, etc.).
- **Course corrections** (comments that changed direction, rollbacks, re-
  dispatches).
- **Escalations** (rejections, failed gates that blocked progress).

### 4. Write the sprint-recap artifact

Produce a `sprint-recap` artifact (via `create-sprint-artifact` with
`docKey: "sprint-recap"`) containing:

```markdown
# Sprint Recap — <sprint name>

## Human-Intervention Timeline

### 2026-07-15 14:32 — Approval Requested (plan-signoff)

**Who:** alice@example.com  
**Why:** Sprint plan ready for sign-off.  
**Source:** `approval:apr_abc123`

---

### 2026-07-15 15:10 — Approval Granted (plan-signoff)

**Who:** bob@example.com  
**Why:** Plan looks good, metrics are falsifiable.  
**Source:** `approval:apr_abc123`

---

### 2026-07-16 09:45 — Comment Added (M5-2)

**Who:** alice@example.com  
**Text:** "The release button should be idempotent — repeated clicks must not
error."  
**Source:** `comment:cmt_def456`

---

### 2026-07-17 11:20 — Stage Rolled Back (M5-3: 测试 → 实施)

**Who:** bob@example.com  
**Why:** Test found a race condition in the reconciler.  
**Source:** `stage:stg_ghi789`

---

## Summary

- **Approvals:** 3 (plan-signoff, ui-signoff, design-signoff) — all granted.
- **Course corrections:** 2 (1 comment clarifying requirements, 1 rollback for
  a test failure).
- **Escalations:** 0.

**Total human interventions:** 5  
**Work items delivered:** 8  
**Intervention rate:** 0.63 per work item (lower is better).
```

### 5. If there are no interventions

If the sprint had zero approvals, zero comments, zero rollbacks, zero re-
dispatches, say so explicitly:

```markdown
## Human-Intervention Timeline

No human interventions were recorded for this sprint. All work items
progressed from dispatch to delivery without manual approval requests,
comments, rollbacks, or re-dispatches.
```

**Never** fabricate interventions to make the recap look more "interesting" or
"realistic." An honest "no interventions" is more valuable than a fictional
timeline.

## Checklist

- [ ] Every timeline entry cites a real record id (approval/comment/stage/run).
- [ ] No entry is fabricated or inferred from code/commits.
- [ ] The timeline is ordered chronologically.
- [ ] The summary counts are accurate (approvals, corrections, escalations).
- [ ] If there are no interventions, the artifact says so explicitly.
- [ ] The sprint-recap artifact is written via `create-sprint-artifact`.
