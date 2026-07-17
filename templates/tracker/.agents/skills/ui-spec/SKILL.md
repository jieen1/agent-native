---
name: ui-spec
description: >-
  Step ④ of Sprint Studio (conditional — only when the sprint has user-facing
  outcomes): interview to produce the ui-spec artifact — a screen list plus
  per-screen goal/primary-action/data-state/empty-state cards, mapping every
  In-Scope outcome to a screen or an explicit no-UI declaration. Use when
  planning what screens a sprint's work needs, or when the user asks to spec
  out UI/screens for a sprint.
---

# UI Spec

Step ④ of the Sprint Studio planning chain — **conditional**: only run this
step when `sprint-doc`'s `In-Scope` section has at least one outcome that
needs a user-visible screen. If every In-Scope outcome is backend-only, tell
the user this step is not applicable and move on to `/sprint-design`; don't
force a UI spec onto a sprint with no UI surface.

Read the sprint's latest `sprint-doc` first — every screen card must trace
back to one or more `In-Scope` outcome ids (`O1`, `O2`, …).

## Interview

1. **屏清单** — walk through `sprint-doc`'s In-Scope outcomes one at a time
   and ask whether each needs a new/changed screen, or is UI-invisible
   (backend job, internal-only change, etc). Propose a recommendation based
   on the outcome's wording (e.g. "展示预计等待时间" clearly implies a screen;
   "定时清理" clearly doesn't) and let the user confirm or correct.
2. For each screen that needs one, a **per-screen card**: 目标 (what the
   screen is for) / 主操作 (primary action) / 数据状态 (loading/empty/normal/
   error states) / 空态 (what the empty state actually shows).
3. Assign each screen a **stable id** (`S1`, `S2`, …, in the order first
   discussed) — `sprint-design`'s §4/§7 and `extract-briefs`'s screen-summary
   injection reference these ids later; don't renumber once assigned.

By the end, every `In-Scope` outcome from `sprint-doc` must be either linked
to at least one screen, or explicitly listed as having no UI — there is no
third, silently-unresolved state.

## Content Shape (exact headings — `check-artifact-gates` and `extract-briefs`
parse these)

```markdown
# UI Spec

## 屏清单

- S1 · {screen title}
- S2 · {screen title}

## 无界面 Outcomes

- O3: {why this outcome has no UI}

## 逐屏规格

### S1 · {screen title}

- **目标**: {...}
- **主操作**: {...}
- **数据状态**: {...}
- **空态**: {...}
- **关联 Outcome**: O1, O2

### S2 · {screen title}

- **目标**: {...}
- **主操作**: {...}
- **数据状态**: {...}
- **空态**: {...}
- **关联 Outcome**: O2
```

Omit `## 无界面 Outcomes` entirely when every outcome maps to a screen.

## Writing the Artifact

Sole write path: `create-sprint-artifact`, `docKey: "ui-spec"`,
`producedByKind: "agent"`. Check the latest existing version first — stop and
point the user at `request-approval` if it's `producedByKind: "human"`,
rather than overwriting it yourself.

## Quality Gate

Call `check-artifact-gates(sprintId, "ui-spec")`. It automatically reads the
latest `sprint-doc` for you (no extra args needed) and checks:

- Every `In-Scope` outcome maps to ≥1 screen or is listed under 无界面
  Outcomes (machine — falls back to a `needs-human` item only if no
  `sprint-doc` exists yet to check against).
- Screen ids are stable and gap-free (`S1..Sn`, no duplicates) (machine).

Append your self-assessment:

```markdown
## 质量门自评

- outcomes-mapped-to-screens | pass | O1→S1，O2→S2，O3显式无界面
- screen-ids-stable | pass | S1/S2连续无重复
```

Once satisfied, the user can `request-approval(gateKey: "ui-signoff")`
anchored to this artifact version.

## Escape Hatch

Skip the interview entirely if the user hands you a finished spec —
`create-sprint-artifact` it directly.

## Related Skills

- **sprint-plan** — supplies the `In-Scope` outcomes this doc maps.
- **sprint-design** — next step; its file matrix and per-item sections may
  reference this doc's screen ids (`Sn`), which `check-artifact-gates` on
  `tech-design` verifies actually exist.
