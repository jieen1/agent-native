---
name: sprint-plan
description: >-
  Step ② of Sprint Studio: interview to produce the sprint-doc artifact —
  Goal, M-numbered falsifiable Success Metrics, In-Scope/Out-of-Scope. Use
  when planning a sprint's goal and scope, or when the user asks to plan,
  scope, or set goals for a sprint.
---

# Sprint Plan

Step ② of the Sprint Studio planning chain. Produces `sprint-doc`, the
anchor artifact for the `plan-signoff` gate (paired with `test-plan`).

## Interview

One question at a time, **always propose a recommended answer first** (accept
it or answer differently — never a blank field as the only option). Two
modes:

- **Full interview** (default): Goal → Success Metrics → In-Scope →
  Out-of-Scope, one section at a time.
- **`--from-brainstorm`**: if a `brainstorm-notes` artifact exists for this
  sprint, read it, draft a full sprint-doc from it, and only ask about the
  gaps the notes didn't resolve — don't re-ask what's already answered.

End with a **holistic reveal**: show the complete draft in one pass before
asking the user to accept it, rather than confirming section-by-section only.

### Goal metrics — the load-bearing part

Every metric needs a **stable M-number** (`M1`, `M2`, …) that never gets
reused or renumbered once assigned — later steps (`test-plan`'s 关联指标,
`sprint-design`'s gap-analysis `metrics[].id`, the coverage matrix) all anchor
to these numbers. Ask, for each candidate metric:

- Is it **Leading** (an early signal) or **Lagging** (an outcome measured
  later)?
- What's the **falsifiable signal** — the specific reading that proves or
  disproves it? Reject vague statements ("提升体验") until the user gives a
  measurable signal.

For every **P0** scope item, run the **delete test**: "如果把这一项从范围里
删掉，Goal 还成立吗？" If deleting it doesn't collapse the Goal, it's probably
not really P0 — push back and ask the user to either re-justify the priority
or downgrade it.

### Hard constraint: no implementation detail

`sprint-doc` is a product document, not a design doc — it must never contain
file paths or code blocks. If the conversation drifts into "we'll add a
column to X table" or similar, redirect that to `/sprint-design` later and
keep this doc in prose.

## Content Shape (exact headings — `check-artifact-gates` and
`extract-goal-metrics` parse these literally)

```markdown
# Sprint Doc

## Goal

{one paragraph}

## Success Metrics

- M1 | Leading | {statement} | {falsifiable signal}
- M2 | Lagging | {statement} | {falsifiable signal}

## In-Scope

- O1: {outcome statement}
- O2: {outcome statement}

## Out-of-Scope

- {statement}
- {statement}
```

The `## Success Metrics` heading and `- M{n} | Leading|Lagging | statement |
signal` line format must match exactly — `extract-goal-metrics.ts`'s
`parseSuccessMetrics` (already-existing action) parses this section
character-for-character, and `check-artifact-gates` reuses that same parser.
`In-Scope` outcomes get their own stable `O{n}` ids the same way — `/ui-spec`
maps every one of them to a screen or an explicit "no UI" declaration later.

## Writing the Artifact

Sole write path: `create-sprint-artifact`, `docKey: "sprint-doc"`,
`producedByKind: "agent"`. Check the latest existing version first
(`get-sprint-artifact`/`list-sprint-artifacts`): if `producedByKind` is
`"human"`, stop and tell the user to run `request-approval` for a
`plan-signoff`-style override and supply the resulting `approvalId` — don't
try to work around the check yourself.

## Quality Gate

Call `check-artifact-gates(sprintId, "sprint-doc")` after writing. It checks,
deterministically:

- Goal metrics carry M-numbers and are Leading/Lagging-tagged (machine).
- Out-of-Scope is non-empty (machine).
- The full document has no file paths or code blocks (machine).
- P0 items pass the delete test (**human** — this needs judgment the parser
  can't make; a human confirms it, the item is never auto-passed).

Also append your own self-assessment:

```markdown
## 质量门自评

- goal-metrics-falsifiable | pass | M1/M2 均带 Leading/Lagging 与可证伪信号
- out-of-scope-non-empty | pass | 列出2条排除项
- no-file-paths-or-code | pass | 全文未出现文件路径或代码块
- p0-delete-test | pass | P0项「xxx」删除后Goal确实不再成立
```

Once `plan-signoff`'s judged-satisfied (this doc + `test-plan`), tell the user
they can `request-approval(gateKey: "plan-signoff")`.

## Escape Hatch

The user can skip the interview entirely and hand you a finished doc (or ask
you to import one) — call `create-sprint-artifact` directly with that content
(`producedByKind: "human"` if it's genuinely theirs, `"agent"` if you wrote it
from their dictation). Don't force the full interview when they already have
an answer.

## Related Skills

- **brainstorm** — optional prior step; its notes can seed `--from-brainstorm`.
- **sprint-test-plan** — next step; its coverage matrix cross-references this
  doc's M-numbers.
- **ui-spec** — later maps every `In-Scope` outcome to a screen.
