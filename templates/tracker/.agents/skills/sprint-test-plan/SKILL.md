---
name: sprint-test-plan
description: >-
  Step ③ of Sprint Studio: interview to produce the test-plan artifact —
  black-box scenario cards with falsifiable pass-fail signals linked to
  sprint-doc's M-numbered metrics. Use when planning how a sprint's work will
  be verified, or when the user asks for test scenarios or a test plan.
---

# Sprint Test Plan

Step ③ of the Sprint Studio planning chain. Produces `test-plan`, the second
half of the `plan-signoff` gate (paired with `sprint-doc`).

Read the sprint's latest `sprint-doc` first (`get-sprint-artifact`) — every
scenario must link back to one of its M-numbered metrics.

## Interview

One scenario card at a time, **recommended answer first** for each field.
For every scenario, ask in order:

1. **Why** — what user goal or risk this scenario protects.
2. **Steps** — the black-box sequence a tester or tool would perform.
3. **Expected** — the observable outcome.
4. **Pass-fail 信号** — the specific, falsifiable signal that decides
   pass/fail. Reject anything that isn't independently checkable ("看起来正常"
   is not a signal; "队列刷新后顺序保持不变" is).
5. **执行工具** — what actually runs this (`playwright`, a specific action
   call, manual click-through, etc).
6. **关联指标** — which `sprint-doc` M-number(s) this scenario covers. Reject
   scenarios with no metric link — ask which metric it protects, or drop it.

**Black-box discipline**: never let internal symbol names, file paths, or
code leak into a scenario's Why/Steps/Expected text — describe behavior a
user or an external test tool can observe, not implementation. If the
conversation naturally wants to reference internals, that belongs in
`/sprint-design`, not here.

If the sprint genuinely has no cross-module integration scenarios (e.g. a
single self-contained change), don't force manufactured scenarios — write one
`## 无集成场景声明` paragraph explaining why instead.

## Content Shape (exact headings — `check-artifact-gates` parses these)

```markdown
# Test Plan

## 场景

### 场景 1 · {标题}

- **Why**: {...}
- **Steps**: {...}
- **Expected**: {...}
- **Pass-fail 信号**: {...}
- **执行工具**: {...}
- **关联指标**: M1, M2

### 场景 2 · {标题}

...
```

Or, when there are no cross-module scenarios:

```markdown
## 无集成场景声明

{一段话说明为何本 sprint 无需跨模块集成场景}
```

The coverage matrix (M × 场景) is **deterministically generated** from the
`关联指标` field by `check-artifact-gates` — don't hand-author it, and don't
let a scenario's metric links drift from what you actually wrote in Why/Steps.

## Writing the Artifact

Sole write path: `create-sprint-artifact`, `docKey: "test-plan"`,
`producedByKind: "agent"`. As always, check the latest existing version first
— if `producedByKind` is `"human"`, stop and point the user at
`request-approval` instead of working around it.

## Quality Gate

Call `check-artifact-gates(sprintId, "test-plan")`. Deterministic checks:

- Every scenario has a non-empty, falsifiable Pass-fail 信号 (machine).
- Black-box language — no code-span leaks in scenario bodies (machine,
  heuristic: this is a regex scan for backtick-quoted symbols, so it can miss
  leaks that aren't backtick-quoted — don't rely on it as the only defense,
  keep discipline during the interview itself).
- Every scenario links to at least one valid M-number (machine).

Append your self-assessment:

```markdown
## 质量门自评

- scenario-falsifiable-signal | pass | 2个场景均有可证伪Pass-fail信号
- black-box-language | pass | 未在场景文本中引用内部符号名
- metrics-linked | pass | 场景1关联M1，场景2关联M1/M2
```

## Escape Hatch

The user can skip straight to a finished test-plan doc — `create-sprint-artifact`
with that content directly, no interview required.

## Related Skills

- **sprint-plan** — prior step; supplies the M-numbers this doc links to.
- **sprint-design** — later step; its verification strategy references this
  doc's scenarios (structurally extracted by `extract-briefs` for
  `sdlc-verify`-bound briefs).
