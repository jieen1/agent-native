---
name: sprint-design
description: >-
  Step ⑤ of Sprint Studio: a four-phase skill (read produced artifacts, read
  real code, write a §1-§9 tech-design doc, self-review) that produces the
  sprint's technical design — one §4 section per work item, a machine-
  parseable §7 file matrix, and API/data-model sections extract-briefs later
  splits into per-item briefs. Use when writing or updating a sprint's
  technical design, or when the user asks for an architecture/design doc for
  a sprint's work items.
---

# Sprint Design

Step ⑤ of the Sprint Studio planning chain. Produces `tech-design` — the
artifact `design-signoff` gates and `extract-briefs` (step ⑦) parses.

This is a **four-phase skill**, not a single-pass interview. Run the phases
in order; don't jump straight to writing.

## Phase 1 — Read Produced Artifacts

Read the sprint's latest `sprint-doc`, `test-plan`, and `ui-spec` (if it
exists) via `get-sprint-artifact`/`list-sprint-artifacts`. Note: the M-numbers
(`sprint-doc`), scenario ids (`test-plan`), and screen ids (`ui-spec`) you'll
cross-reference later all come from here — don't invent new ones.

## Phase 2 — Read Real Code

Before describing how something will be built, actually read the real source
it touches — through whatever read access you have to the project's own
checkout in this session (e.g. as a connected coding agent with the repo
available). Do not describe file changes from memory or guesswork.

**Honest limit**: `check-artifact-gates`'s file-path checks on this doc are
text-consistency checks (does §4 mention a path that also appears in §7?),
**not** real filesystem existence checks — tracker itself has no project
checkout to verify against. If you have real repo access in this session, use
it to make the paths and content genuinely accurate; if you don't, say so
explicitly in §9 rather than presenting guessed paths as verified.

## Phase 3 — Write the §1–§9 Doc

One `## §N` heading per section, exactly as below — `check-artifact-gates`
and `extract-briefs` both parse these headings literally.

```markdown
# {Sprint} 技术设计

## §1 概览

{one paragraph — what this sprint delivers, at a product level}

## §2 约定

{naming/directory conventions, cross-cutting rules — this section gets
copied verbatim into shared-brief by extract-briefs}

## §3 架构

{how the pieces fit together — prose and/or a diagram}

## §4 工作项设计

### §4.1 {itemKey} · {work item title}

- **依赖**: {comma-separated itemKeys this depends on, or 无}

{free-form body: what changes and why, files/behavior in enough detail that
extract-briefs's per-item brief is self-contained}

### §4.2 {itemKey} · {work item title}

...

{one §4.N subsection per sprint work item — check-artifact-gates checks this
count matches the sprint's actual work-item count}

## §5 数据模型

{schema/shape changes — copied into shared-brief verbatim}

## §6 API 表

| 方法 | 路径 | 生产方 | 消费方 | 说明 |
| --- | --- | --- | --- | --- |
| GET | /api/... | {itemKey} | {itemKey} | {...} |

{producer/consumer columns feed extract-briefs's dependency-edge inference
— an item consuming another's endpoint depends on that item}

## §7 文件变更矩阵

| 文件路径 | 操作 | 所属工作项 | 说明 | 依赖文件 |
| --- | --- | --- | --- | --- |
| \`path/to/file.ts\` | CREATE\|MODIFY\|DELETE | {itemKey} | {...} | \`other/file.ts\` |

{五列, machine-parseable — 操作 must be exactly CREATE, MODIFY, or DELETE;
依赖文件 lets extract-briefs infer file-level dependency edges between items}

## §8 测试策略

{how this sprint's changes get verified at a technical level — copied into
shared-brief verbatim}

### Env Vars

- \`SOME_ENV_VAR\`: {what it controls}

## §9 自审

{Phase 4's findings — see below}
```

If §4 references a `ui-spec` screen id (`S1`, `S2`, …), write it as the bare
token (`S1`) somewhere in that item's body — `check-artifact-gates` scans for
`S\d+` tokens and verifies each one actually exists in `ui-spec`.

## Phase 4 — Self-Review

Before writing, re-read your own §4/§7: does every file path mentioned in a
§4 body also appear as a row in §7 (or vice versa)? Does every referenced
screen id actually exist in `ui-spec`? Record what you checked — and its
honest limits — in §9, e.g.:

> §4/§7 路径已交叉核对一致；本次会话具备真实仓库读取权限，已核对
> \`server/lib/scale-estimate.ts\` 确实存在且签名与描述一致。/ 本次会话无仓库
> checkout，以上路径未做真实存在性核验，需要 ⑥ 对抗评审或执行期 diff 围栏兜底。

## Writing the Artifact

Sole write path: `create-sprint-artifact`, `docKey: "tech-design"`,
`producedByKind: "agent"`. Check the latest existing version first — if
`producedByKind` is `"human"`, stop and route the user to `request-approval`
instead of overwriting.

## Quality Gate

Call `check-artifact-gates(sprintId, "tech-design")`. It automatically reads
the sprint's work-item count and the latest `ui-spec` for you. Checks:

- §4 section count equals the sprint's work-item count (machine — needs-human
  if the work-item count can't be resolved).
- §7's file matrix is present, parseable, and every 操作 is
  CREATE/MODIFY/DELETE (machine).
- Every `Sn` screen id referenced in the doc exists in `ui-spec` (machine —
  trivially passes if none are referenced).
- File-path text consistency between §4 and §7 (machine, **not** real
  filesystem existence — see Phase 2's honest-limit note).

Append your self-assessment (include what Phase 4 found):

```markdown
## 质量门自评

- section-count-matches-items | pass | §4含3节，sprint有3个工作项
- file-matrix-parseable | pass | §7共5行，操作值均合法
- ui-spec-screen-refs-exist | pass | 引用的S1/S2均存在于ui-spec
- file-path-format-consistency | pass | §4提及路径均出现在§7矩阵
```

Once satisfied, the user can `request-approval(gateKey: "design-signoff")` —
required (or an explicit, traced `force`) before `extract-briefs` will run.

## Escape Hatch

Skip the interview/phases entirely if the user hands you a finished design
doc — `create-sprint-artifact` it directly, keeping the §1–§9 heading
convention so downstream parsing still works.

## Related Skills

- **sprint-plan**, **sprint-test-plan**, **ui-spec** — Phase 1 inputs.
- **sprint-review** — the mandatory independent-session adversarial pass that
  follows this step, producing tech-design vN+1.
- **self-modifying-code** — how repo read/write access actually works in this
  session, if you need to check what's available for Phase 2.
