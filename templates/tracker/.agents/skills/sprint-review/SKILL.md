---
name: sprint-review
description: >-
  Step ⑥ of Sprint Studio: independent adversarial review of tech-design that
  must run in a session separate from the one that authored the design — self-
  review of self-authored specs empirically misses real bugs that independent
  review catches. Use when a tech-design needs adversarial review before
  design-signoff, or when the user asks to review or challenge a design.
---

# Sprint Review

Step ⑥ of the Sprint Studio planning chain. Produces a new `tech-design`
version (supersedes chain) folding in the review's accepted findings.

## Hard Constraint: Independent Session

**This review must run in a session that did not author the spec being
reviewed.** Do not run this skill as a continuation of the same conversation
that wrote or last edited the `tech-design` you're reviewing.

This is not a stylistic preference — it's an empirical finding from this same
codebase's own self-bootstrap dogfooding: a self-review pass, run by the
author of the spec in the same session, found **zero** real issues in its own
design; an independent review pass of someone else's spec, same effort level,
found **five** real defects. Self-review of self-authored specs misses real
bugs; independent review catches them. If you notice you *are* the author
(you wrote the version being reviewed, or you can recall writing it earlier
in this conversation), **stop and say so** — tell the user a fresh, separate
session needs to run this review instead of continuing in-place.

Two review-carrier tiers (pick based on current health, tell the user which
one you're using and why):

- **v1 (default, always available)**: a brand-new tracker chat session —
  independence comes from context isolation (new session, no memory of
  authoring the spec), same underlying model.
- **v2 (model-independent, requires vLLM)**: dispatch the review through the
  orchestrator's `spawnOnce` on a different model than whatever wrote the
  spec. Only use this tier when vLLM is confirmed healthy — fall back to v1
  otherwise rather than blocking the review on an unavailable engine.

## Review Session Setup

The reviewing session's input is:

- The **original requirement text** (the sprint's `sprint-doc` Goal/In-Scope,
  and any source requirement the sprint traces back to) — not just the spec.
- The `tech-design` artifact under review, in full.

Explicitly instruct the reviewing pass to **challenge the spec's own design
decisions** — not just check internal consistency. "Does this design actually
solve the stated goal?" and "would a different approach avoid this
complexity?" are in scope, not just "does §4 match §7".

## Multi-Round Process

1. Round 1: full read, list every finding (issue + why it matters + where in
   the doc).
2. Before each subsequent round, carry forward the **cumulative list of
   already-reported findings** so a later round doesn't re-report the same
   thing as if it were new — new rounds should surface *additional* issues,
   not restate old ones.
3. Filter for **high-confidence, new** findings only at each round — a vague
   "this could maybe be better" is not a finding; something concretely wrong
   or missing is.
4. Fold every accepted finding into a revised `tech-design` — write the
   revision as a new version via `create-sprint-artifact` (see below), not as
   a separate document.
5. Stop when a round produces zero new high-confidence findings.

## Report Table

Append this table to the revised `tech-design` (in §9 自审, alongside the
authoring skill's own self-review notes):

```markdown
## 评审记录

| 轮次 | 评审载体 | 发现 | 处置 |
| --- | --- | --- | --- |
| 1 | tracker 独立会话 (v1) | §4.2 遗漏 PRJ-003 的依赖声明 | 已补充 |
| 2 | tracker 独立会话 (v1) | 无新增高置信发现 | 结束 |
```

## Writing the Artifact

Sole write path: `create-sprint-artifact`, `docKey: "tech-design"` (this
naturally creates the next version and sets `supersedes` — you do not choose
the version number). `producedByKind: "agent"`. As always, check the latest
version's `producedByKind` first; if it's `"human"`, stop and route through
`request-approval` instead of overwriting.

## Quality Gate

The new version goes through the **same** `check-artifact-gates(sprintId,
"tech-design")` rule set as `/sprint-design`'s output (see that skill for the
full rule list) — a review revision isn't exempt from §4/§7 consistency
checks just because it came from a review pass. Append the same
`## 质量门自评` structure, re-assessed against the revised content.

## Escape Hatch

If the user already has an externally-reviewed design (e.g. reviewed outside
this tool), they can hand you the final content to save directly via
`create-sprint-artifact` — you don't have to re-run the interview/rounds
described above, but do still note in the report table that the review
happened elsewhere, for the version history's sake.

## Related Skills

- **sprint-design** — authors the version this skill reviews; the constraint
  above exists specifically because those two must not share a session.
- **harness-agents** — if using the v2 (orchestrator `spawnOnce`) carrier
  tier, this covers how that dispatch actually works.
