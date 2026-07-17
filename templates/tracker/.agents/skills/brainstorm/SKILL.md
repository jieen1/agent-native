---
name: brainstorm
description: >-
  Optional first step of the Sprint Studio planning chain: an interview that
  turns loose ideas into a falsifiable shortlist before /sprint-plan. Use when
  the user wants to explore a sprint's direction before committing to a goal,
  or explicitly asks to brainstorm for a sprint.
---

# Brainstorm

Step ① of the Sprint Studio planning chain (`①头脑风暴(可选) → ②Sprint 规划 →
③测试计划 → ④UI 设计(条件) → ⑤技术设计 → ⑥对抗评审 → ⑦Briefs`). This step is
**optional** — a user can skip straight to `/sprint-plan`, or import an
existing notes doc as the artifact (see "Escape Hatch" below). Never treat
this step as mandatory.

## Interview

One question at a time. **Always give a recommended answer first**, then ask
the user to accept it or answer differently — never present an open blank
field as the only option. Four opening modes (ask which fits, recommend the
one the conversation already implies):

1. **问题**: 一句话描述当前遇到的问题或痛点。
2. **半成形想法**: 已经有一个大致方向，但细节没想清楚。
3. **开放问题**: 想探索一个方向，还没有具体方案。
4. **约束**: 从已知的硬约束（时间/团队/技术）反推能做什么。

After the opening, converge toward 2-3 candidate directions:

- If the conversation converges onto a **single** plan too early, push back:
  require at least two alternative directions before continuing, even if one
  is clearly weaker — the point is surfacing the tradeoff, not padding.
- For each candidate idea, ask **how you'd know it worked** (a falsifiable
  test). An idea nobody can describe a check for gets marked "淘汰候选"
  (elimination candidate) in the notes rather than carried forward silently.
- Any time the user says "just finalize this", stop the interview and move to
  the write step with the current draft.

## Writing the Artifact

Sole write path: `create-sprint-artifact` with `docKey: "brainstorm-notes"`,
`producedByKind: "agent"`. Before writing, check the latest existing version
for this `sprintId` + docKey (`list-sprint-artifacts` or `get-sprint-artifact`):
if its `producedByKind` is `"human"`, **stop** — do not retry or guess around
it. Tell the user the current version is human-authored and needs
`request-approval` + the resulting `approvalId` before an agent version can
supersede it. `create-sprint-artifact` enforces this itself; the point of
checking first is telling the user clearly instead of surfacing a raw error.

Content shape:

```markdown
# Brainstorm Notes

## 开场

{which of the 4 modes, and the one-line description}

## 候选方向

### 方向 1: {title}

- 描述: ...
- 检验方式: {falsifiable check, or "淘汰候选" + why}

### 方向 2: {title}

...

## 开放问题

- ...
```

## Quality Gate Self-Assessment

Every produced artifact ends with this structured section — `key | verdict |
evidence`, one gate per line:

```markdown
## 质量门自评

- at-least-two-directions | pass | 列出方向1/方向2两个候选
- falsifiable-check-per-direction | pass | 每个候选方向都写了检验方式或标记淘汰候选
```

There is **no deterministic `check-artifact-gates` rule set for
`brainstorm-notes`** — this step is optional and has no hard gate
(`r4-workflow-families-planning-skills.md` §5.2). The self-assessment above is
advisory, not a blocking gate.

## Escape Hatch

At any point the user can skip this step entirely — go straight to
`/sprint-plan`, or hand you a finished notes doc to save verbatim via
`create-sprint-artifact` (`producedByKind: "human"` if it's genuinely their
own writing, `"agent"` if you're transcribing/summarizing on their behalf).
Do not insist on running the full interview when the user already knows what
they want.

## Related Skills

- **sprint-plan** — the next step; can consume this step's notes via
  `--from-brainstorm`-style summarization (read the latest `brainstorm-notes`
  artifact and open with a draft instead of a blank interview).
