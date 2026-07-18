/**
 * S8 workflow library seed data (docs/sdlc-product-design/r4-workflow-families-
 * planning-skills.md — R4a task board #77). Exported as plain data (not
 * inserted directly here) so:
 *   - `workflow-templates-seed.ts` (the boot plugin) can upsert it against a
 *     real Postgres connection, and
 *   - `workflow-library-seed.spec.ts` can run every entry's `dag` through the
 *     real `validateDag()` with zero DB — proving the seed is actually
 *     save-able before it ever reaches a boot-time try/catch that would
 *     otherwise swallow a validation failure silently.
 *
 * Family taxonomy (r4 doc §4.1): `core | sdlc | light | custom`.
 *
 *  - `core` (new, 4 entries): brain-composition micro-workflows. These are
 *    NOT originally-authored seed content — they are the production-verified
 *    brain lineage (101 `v3_workflow_templates`, 2026-07-17 read-only SQL)
 *    collected into the repo verbatim, per r4 doc §1.2/§4.1: "把生产验证过的
 *    brain 血统收编入仓". `sdlc-dev`/`sdlc-review`/`sdlc-audit`/`sdlc-full`
 *    use the REAL production `agent` values as pulled — including the
 *    non-builtin custom agent-defs "reviewer"/"auditor" that brain itself
 *    created in production (101: engine=vllm, model=claude-sonnet-4-6, both
 *    `builtin:0`). This template's own `agent-defs-seed.ts` only seeds
 *    "vllm"/"claude-code"/"brain" — a fresh environment seeded ONLY from this
 *    file would have core-lineage templates referencing "reviewer"/"auditor"
 *    agent names that don't resolve to a registered agent-def until an
 *    operator also creates them (out of scope here: agent-defs-seed.ts is a
 *    different plugin, untouched by this task). Faithfulness to the real
 *    production dag was prioritized over silently substituting a different
 *    agent name.
 *  - `sdlc` (5 entries): `sdlc-verify`/`sdlc-gap-analysis`/`sdlc-ui-build` are
 *    genuinely seed-authored (hardened to r4 §4.3 Profile A in this task).
 *    `sdlc-promote`/`sdlc-issue-pipeline` are the other two names r4 §1.2
 *    proved NEVER actually reached production as seed content — the boot
 *    script's "name already exists → patch meta only, never touch dag" path
 *    (see workflow-templates-seed.ts) silently protected two pre-existing
 *    brain-authored rows from ever being overwritten by this file's OLD
 *    (dead-code) dag content, while still mis-tagging them `builtin:true`.
 *    Both entries now carry the REAL production dag (101, read-only SQL) so
 *    that seeding a brand-new environment from this file plants the actual
 *    proven shape instead of a stale hand-drawn stub.
 *  - `light` (4 entries): quick-task/hotfix/docs-task/spike-research,
 *    genuinely seed-authored, hardened to Profile A in this task.
 *  - `custom`: never appears in this static array — assigned dynamically to
 *    non-builtin templates saved by brain/human (workflowSave), outside this
 *    file's scope.
 *
 * Profile A hardening (r4 §3 P-A, §4.3): every agent node that touches real
 * code carries `workspace: "{{inputs.workspaceId}}"`; every judgment node
 * (guard/until source) carries `output_schema` with an enum verdict field;
 * bounded rounds are guard-unrolled (not `loop` — loop node instances in
 * production were never actually executed, r4 §1.2); delivery-tail nodes
 * (pr/publish/merge/建单 — anything only brain's own actions
 * `workspaceCommitPush`/`workspaceCiWatch`/`workspaceMergePr` can actually do)
 * are removed from the DAG — that responsibility moves to brain's own turn.
 *
 * Guard-chain correctness fix (task board #83, closed out after being flagged
 * non-blocking/out-of-scope during R4a.2 dispatch-grade-lint review):
 * `v3-dispatcher.ts`'s `getNodeDeps()` / `v3-reconciler.ts`'s
 * `buildGuardContext()` both resolve `deps.<id>` ONLY from a node's OWN
 * direct `deps` array — never transitively — by design (no auto-injection,
 * see `orchestrating-v3` skill's channel contract). There is no supported
 * transitive-dependency pattern; `dag-validator.ts` now enforces this (a
 * node's `guard`/`prompt`/`items_from` may only reference `deps.<id>` for an
 * `id` in that node's own `deps` array).
 *
 * The REAL production `sdlc-review` v4 / `sdlc-audit` v2 / `sdlc-full` v1 /
 * `sdlc-issue-pipeline` v4 core-lineage dags transcribed into this file
 * originally carried this exact bug: their SECOND guard hop (e.g. audit v2's
 * `audit2` node) referenced `deps.audit1...` even though `audit1` was not in
 * `audit2`'s own `deps` (only `close1` was) — resolving to `undefined` at
 * guard-evaluation time. In practice this was harmless-by-accident: the
 * custom expression evaluator's `!=` against an unresolved path is always
 * `true`, and the reconciler's cascade-skip (a pending node auto-skips once
 * ALL of its direct deps are skipped) already fires BEFORE guard evaluation,
 * so the correct skip/run outcome happened either way — but it was a landmine
 * (fragile, unintentionally-correct, and un-validated) and not, on inspection,
 * the actual cause of those templates' real run stats including failures
 * (`sdlc-review` v4: done 1 / failed 2; `sdlc-audit` v2: done 1 / failed 2).
 * Fixed here by adding the referenced ancestor node to the guard's own node's
 * `deps` array (e.g. `audit2.deps: ["audit1", "close1"]`) — this doesn't
 * change execution order (the ancestor was already guaranteed to resolve
 * first via the intermediate node) but makes the reference genuinely
 * resolve instead of accidentally-true-by-`undefined`. The freshly-authored
 * `sdlc-gap-analysis` entry below never had this bug: its multi-round guard
 * chain relies on the same cascade-skip so only the FIRST hop of each round
 * needs an explicit guard.
 */

export type WorkflowFamily = "core" | "sdlc" | "light" | "custom";

export interface WorkflowSeedEntry {
  name: string;
  family: WorkflowFamily;
  tags: string[];
  description: string;
  changeNote: string;
  dag: { nodes: unknown[] };
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const DEV = "vllm";
const REVIEW = "claude-code";

export const WORKFLOW_LIBRARY_SEED: WorkflowSeedEntry[] = [
  // ── core 血统 · 收编自 101 自举实绩（不是本文件原创内容） ──────────────────
  {
    name: "sdlc-dev",
    family: "core",
    tags: ["brain 微工作流", "单节点"],
    description:
      "Development node. Engine is CONFIGURABLE: defaults to local vLLM (agent vllm) but inputs.devEngine can override to any registered engine/runtime. Brain (CC) analyzes+reviews+commits.",
    changeNote:
      "收编自 101 自举血统 v5（run 实绩：done 28 / cancelled 15）。brain 组合用单节点微工作流——analyze→dev→review→commit 由 brain 在多个微 run 之间自行组合，不是一个大 DAG。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "develop",
          agent: "vllm",
          prompt:
            "你是开发者。请在当前 workspace 用 Read/Edit/Write/Bash 完成下面的开发规格,实现全部代码改动:\n\n{{inputs.spec}}\n\n严格遵守工程约束(只改指定文件/范围、DB 变更加性、复用现有写法、新表要有建表迁移)。**不要运行 pnpm install 或构建**。完成后简述改/新建了哪些文件及关键改动。",
          workspace: "{{inputs.workspaceId}}",
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["spec", "workspaceId"],
      properties: {
        spec: { type: "string" },
        devEngine: { type: "string" },
        workspaceId: { type: "string" },
      },
    },
  },
  {
    name: "sdlc-review",
    family: "core",
    tags: ["brain 微工作流", "guard 展开三轮"],
    description:
      "Multi-round review (up to 3 rounds, unrolled with guards): vLLM develops, reviewer (Sonnet) reviews; if changes requested, vLLM fixes and reviewer re-reviews; stops early once approved. Core SDLC quality gate.",
    changeNote:
      "收编自 101 自举血统 v4（run 实绩：done 1 / failed 2）。guard 展开三轮评审取代 loop 节点——loop 节点在生产中从未被真正跑起来（r4 doc §1.2：3 条 loop 实例全部 status∈{pending,skipped}）。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "develop",
          agent: "vllm",
          prompt:
            "你是开发者。在当前 workspace 用 Read/Edit/Write/Bash 完成开发规格:\n\n{{inputs.spec}}\n\n严格遵守工程约束(只改指定文件/范围、加性变更、复用现有写法、失败记日志不静默吞错、启动逻辑幂等)。不要 pnpm install 或构建。完成后简述改了哪些文件。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "review1",
          agent: "reviewer",
          deps: ["develop"],
          prompt:
            "审查当前 workspace 改动(先 git diff,再读改动文件)。对照规格找真实缺陷。规格:\n{{inputs.spec}}\n只审查不改代码。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              issues: { type: "array" },
              summary: { type: "string" },
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
            },
          },
        },
        {
          type: "agent",
          id: "fix1",
          agent: "vllm",
          deps: ["review1"],
          guard: "deps.review1.output.verdict != 'approved'",
          prompt:
            "审查者(第1轮)提出了修改意见,请在当前 workspace 逐条修复。审查结果:\n{{deps.review1.output}}\n只修这些问题,不引入无关改动。完成后简述改了什么。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "review2",
          agent: "reviewer",
          deps: ["review1", "fix1"],
          guard: "deps.review1.output.verdict != 'approved'",
          prompt:
            "开发者已按第1轮意见修复。再次审查当前 workspace 改动,对照规格找剩余缺陷。规格:\n{{inputs.spec}}\n只审查不改代码。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              issues: { type: "array" },
              summary: { type: "string" },
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
            },
          },
        },
        {
          type: "agent",
          id: "fix2",
          agent: "vllm",
          deps: ["review2"],
          guard: "deps.review2.output.verdict != 'approved'",
          prompt:
            "审查者(第2轮)仍有意见,请逐条修复。审查结果:\n{{deps.review2.output}}\n只修这些。完成后简述。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "review3",
          agent: "reviewer",
          deps: ["review2", "fix2"],
          guard: "deps.review2.output.verdict != 'approved'",
          prompt:
            "第3轮(最终)审查当前 workspace 改动,对照规格给最终结论。规格:\n{{inputs.spec}}\n只审查不改代码。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              issues: { type: "array" },
              summary: { type: "string" },
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["spec", "workspaceId"],
      properties: {
        spec: { type: "string" },
        workspaceId: { type: "string" },
      },
    },
  },
  {
    name: "sdlc-audit",
    family: "core",
    tags: ["brain 微工作流", "Phase H 目标审计"],
    description:
      "Phase H goal audit loop (up to 3 rounds, guard-unrolled): auditor (Sonnet) checks whether the goal is truly met using evidence, not a task checklist. If gaps, vLLM closes them, then re-audit. Stops at NO_GAPS or 3 rounds. Close nodes read the whole audit output (robust).",
    changeNote:
      "收编自 101 自举血统 v2（run 实绩：done 1 / failed 2）。auditor 只看 diff/证据判断目标是否真正达成,不看任务清单。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "audit1",
          agent: "auditor",
          prompt:
            "对下面的目标做 Phase H 目标审计。用 git diff、Read、grep 核实当前 workspace 是否真正达成目标(不看任务清单,只看代码/证据)。\n\n目标:\n{{inputs.goal}}\n\n给出结构化 verdict 与证据。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              gaps: { type: "array" },
              summary: { type: "string" },
              verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
            },
          },
        },
        {
          type: "agent",
          id: "close1",
          agent: "vllm",
          deps: ["audit1"],
          guard: "deps.audit1.output.verdict != 'NO_GAPS'",
          prompt:
            "目标审计发现未达成的 gap,请在当前 workspace 补齐,使目标真正达成。\n目标:{{inputs.goal}}\n审计结果:\n{{deps.audit1.output}}\n只补齐这些 gap,不引入无关改动。完成后简述改了什么。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "audit2",
          agent: "auditor",
          deps: ["audit1", "close1"],
          guard: "deps.audit1.output.verdict != 'NO_GAPS'",
          prompt:
            "开发者已按第1轮审计补齐 gap。再次做目标审计(核实证据)。\n目标:\n{{inputs.goal}}\n给出结构化 verdict 与证据。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              gaps: { type: "array" },
              summary: { type: "string" },
              verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
            },
          },
        },
        {
          type: "agent",
          id: "close2",
          agent: "vllm",
          deps: ["audit2"],
          guard: "deps.audit2.output.verdict != 'NO_GAPS'",
          prompt:
            "第2轮审计仍有 gap,请补齐。\n目标:{{inputs.goal}}\n审计结果:\n{{deps.audit2.output}}\n只补这些。完成后简述。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "audit3",
          agent: "auditor",
          deps: ["audit2", "close2"],
          guard: "deps.audit2.output.verdict != 'NO_GAPS'",
          prompt:
            "第3轮(最终)目标审计。核实证据后给最终 verdict。若仍 GAPS_FOUND,说明需升级人工。\n目标:\n{{inputs.goal}}",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              gaps: { type: "array" },
              summary: { type: "string" },
              verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["goal", "workspaceId"],
      properties: {
        goal: { type: "string" },
        workspaceId: { type: "string" },
      },
    },
  },
  {
    name: "sdlc-full",
    family: "core",
    tags: ["brain 微工作流", "端到端单链"],
    description:
      "End-to-end SDLC quality pipeline for one task: vLLM develops -> multi-round review (Sonnet, up to 2 fix rounds, guard-unrolled) -> Phase H goal audit (Sonnet, evidence-based, one close round). One task flows through all gates automatically.",
    changeNote:
      "收编自 101 自举血统 v1（run 实绩：done 1）。dev→多轮评审→目标审计的端到端单链,一次 run 走完全部质量门。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "develop",
          agent: "vllm",
          prompt:
            "你是开发者。在当前 workspace 完成开发规格:\n\n{{inputs.spec}}\n\n严格遵守工程约束(只改指定文件/范围、加性变更、失败记日志不静默吞错、启动逻辑幂等)。不要 pnpm install 或构建。完成后简述改了哪些文件。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "review1",
          agent: "reviewer",
          deps: ["develop"],
          prompt:
            "审查当前 workspace 改动(git diff + 读文件),对照规格找真实缺陷。规格:\n{{inputs.spec}}\n只审查不改代码。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              issues: { type: "array" },
              summary: { type: "string" },
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
            },
          },
        },
        {
          type: "agent",
          id: "reviewfix",
          agent: "vllm",
          deps: ["review1"],
          guard: "deps.review1.output.verdict != 'approved'",
          prompt:
            "审查者提出修改意见,请逐条修复。审查结果:\n{{deps.review1.output}}\n只修这些。完成后简述。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "review2",
          agent: "reviewer",
          deps: ["review1", "reviewfix"],
          guard: "deps.review1.output.verdict != 'approved'",
          prompt:
            "开发者已按意见修复。再次审查当前 workspace 改动,对照规格给结论。规格:\n{{inputs.spec}}\n只审查不改代码。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              summary: { type: "string" },
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
            },
          },
        },
        {
          type: "agent",
          id: "audit",
          agent: "auditor",
          deps: ["review1", "review2"],
          prompt:
            "代码已通过审查。现在做 Phase H 目标审计:用 git diff、Read、grep 核实是否真正达成目标(不看任务清单,只看证据)。\n\n目标:\n{{inputs.goal}}\n\n给出结构化 verdict 与证据。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              gaps: { type: "array" },
              summary: { type: "string" },
              verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
            },
          },
        },
        {
          type: "agent",
          id: "auditclose",
          agent: "vllm",
          deps: ["audit"],
          guard: "deps.audit.output.verdict != 'NO_GAPS'",
          prompt:
            "目标审计发现 gap,请补齐使目标真正达成。目标:{{inputs.goal}}\n审计结果:\n{{deps.audit.output}}\n只补齐这些 gap。完成后简述。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "audit2",
          agent: "auditor",
          deps: ["audit", "auditclose"],
          guard: "deps.audit.output.verdict != 'NO_GAPS'",
          prompt:
            "开发者已补齐 gap。最终目标审计,核实证据后给最终 verdict。目标:\n{{inputs.goal}}",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              summary: { type: "string" },
              verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["spec", "goal", "workspaceId"],
      properties: {
        goal: { type: "string" },
        spec: { type: "string" },
        workspaceId: { type: "string" },
      },
    },
  },
  {
    name: "sdlc-merge-review",
    family: "core",
    tags: ["brain 微工作流", "合并前独立复核"],
    description:
      'Mandatory pre-merge independent review (task board #95). A SEPARATE dispatch from the dev/review DAG that produced the diff — a fresh `agent:"claude-code"` pass, scoped to the workspace, that re-fetches the real diff itself (git/gh, not a cached summary) and gives an adversarial safe_to_merge/concerns_found verdict. Gates RunMergeControl\'s merge button (server/engine/merge-review-gate.ts) — a human may still override a concerns_found verdict with an explicit reason, but the default/disabled state requires one or the other, never a silent bypass.',
    changeNote:
      "本条目本文件原创(不是收编自 101 血统，与另外 4 条 core 条目不同)。single-node 独立复核微工作流,由 mergeReviewStart action 派发,tags.mergeReviewFor 标记所属 workspace,供 mergeReviewGet 读取 verdict。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "merge_review",
          agent: "claude-code",
          workspace: "{{inputs.workspaceId}}",
          prompt:
            "你是一名独立于原开发者和原评审者的对抗式复核者(adversarial reviewer),你的唯一职责是判断这次改动现在是否已经足够安全、可以进入 main 分支——不是提供一般性建议,也不是重复别人的结论。你自己不执行任何 git 写操作,只给出结论。\n\n不要相信任何已有的评审摘要或既定结论。先在当前 workspace 亲自重新取证:用 `git --no-pager diff` 对比 base 分支(如 `git merge-base origin/main HEAD` 或等效基线)取得真实 diff;如果有已开 PR({{inputs.prUrl}}),尽量用 `gh pr diff` 交叉核实;然后亲自读改动到的文件。把这当成挑错,而不是走流程盖章。\n\n原始需求/规格,用来判断改动是否真的解决了问题(而不只是'看起来改了什么'):\n\n{{inputs.spec}}\n\n至少覆盖以下几类,每一类都要给出具体依据(文件/行为),不要泛泛而谈:\n1) 是否真正解决了上面规格描述的问题,有没有遗漏的需求点。\n2) 测试覆盖——改动是否有对应的真实测试,测试是否会在改动被撤销时失败(而不是空转/总是通过)。\n3) 代码质量与复用——明显的重复、可简化、或违反本仓库既有写法的地方。\n4) 安全问题——硬编码密钥/凭据/token、越权访问、注入风险、缺少权限校验的写操作。\n5) 破坏性 schema 变更——DROP/RENAME/截断表或列、非加性迁移。\n6) 遗留的调试代码、无关改动、被注释掉或跳过的测试。\n\n给出结构化结论:verdict 只有在你确实没有发现任何值得阻塞的问题时才是 safe_to_merge;只要发现任何一条真实问题,都必须是 concerns_found,并在 findings 数组里逐条列出(每条包含具体位置和为什么值得阻塞)。summary 用一到两句话给出你的整体判断,不要含糊其辞。\n\n你的最终回复必须且只能是一个原始 JSON 对象本身:不要用 markdown 代码块或```围栏包裹它,不要在 JSON 前面写分析过程/前言,也不要在 JSON 后面加总结或说明——整段回复要能被 JSON.parse 直接解析,一个字符都不能多。",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              findings: { type: "array" },
              summary: { type: "string" },
              verdict: {
                type: "string",
                enum: ["safe_to_merge", "concerns_found"],
              },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["workspaceId", "spec"],
      properties: {
        workspaceId: { type: "string" },
        spec: { type: "string" },
        prUrl: { type: "string" },
      },
    },
  },

  // ── sdlc 族 · 内置 ─────────────────────────────────────────────────────────
  {
    name: "sdlc-issue-pipeline",
    family: "sdlc",
    tags: ["sprint 开发项", "TDD 红先行"],
    description:
      "多轮审查流水线(dev->qa->review1-3->gate/diff-audit)。reviewEscalate 已从 human_gate 改为自动化 agent 判断节点——这是无人值守流水线,不设人工审批阻塞点;3 轮审查仍不通过时由 agent 自主判定 approve/reject。",
    changeNote:
      "此条目此前是种子自行编写的 dev→qa→reviewer→loop→gate→diff-audit→pr 死代码——`workflow-templates-seed.ts` 撞名机制下从未真正写入生产(r4 doc §1.2)。现替换为 101 生产 v4 的真实 dag(brain 于 2026-07-08 迭代至 14 节点成熟形态:dev(TDD 双 commit 纪律)→qa→devFix/qa2(guard)→review1-3(guard 展开三轮)→reviewEscalate(无人值守自裁决,agent claude-code)→gateStack/gateTests/gateNone(按项目 gateMode 三选一分支)→diffAudit(git diff --name-only 确定性范围核对),run 实绩 done 5 / cancelled 14;v2/v3/v4 均 0 运行)。这份内容是从生产只读查询取得,不是本文件原创设计。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: "vllm",
          deps: [],
          prompt:
            "你是开发者(TDD)。在当前 workspace 完成以下开发规格:\n\n{{inputs.spec}}\n\n严格遵守 TDD 顺序:\n1) 先编写一个会失败的测试(red),单独 git commit(commit message 以 'test:' 开头,不要和实现代码混在一起)。\n2) 再实现功能使测试通过(green),再次单独 git commit(commit message 以 'feat:' 或 'fix:' 开头)。\n两次 commit 的顺序必须是:测试 commit 在前,实现 commit 在后 —— 这会被后续流程用 git log 核实。\n只改动声明范围内的文件,范围(glob):{{inputs.scopeGlobs}}\n不要执行 pnpm install 或构建。完成后用 git log --oneline 简述两次 commit 及改了哪些文件。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "qa",
          agent: "vllm",
          deps: ["dev"],
          prompt:
            "你是 QA。在当前 workspace 基于以下规格补充端到端/集成测试,覆盖真实用户可见行为(不是重复 dev 阶段已写的单测):\n\n{{inputs.spec}}\n\n运行你新增的测试,给出结论。只新增测试文件,不要修改被测的实现代码。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              summary: { type: "string" },
              verdict: { type: "string", enum: ["pass", "fail"] },
            },
          },
        },
        {
          type: "agent",
          id: "devFix",
          agent: "vllm",
          deps: ["qa"],
          guard: "deps.qa.output.verdict != 'pass'",
          prompt:
            "QA 发现了问题,请修复。QA 结果:\n{{deps.qa.output}}\n只修复这些问题,不要引入声明范围之外的改动。完成后简述修改。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "qa2",
          agent: "vllm",
          deps: ["qa", "devFix"],
          guard: "deps.qa.output.verdict != 'pass'",
          prompt:
            "开发者已修复上一轮 QA 发现的问题。重新运行端到端测试并验证,给出最终结论。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              summary: { type: "string" },
              verdict: { type: "string", enum: ["pass", "fail"] },
            },
          },
        },
        {
          type: "agent",
          id: "review1",
          agent: "vllm",
          deps: ["qa", "qa2"],
          prompt:
            "你是代码审查者。审查当前 workspace 的改动(用 git diff 查看),对照以下规格判断实现质量与改动范围是否合规:\n\n{{inputs.spec}}\n\n声明的改动范围(glob):{{inputs.scopeGlobs}}\n\n如果改动涉及声明范围之外的文件,verdict 必须是 changes_requested,并在 issues 中明确指出越界文件。只审查,不要修改代码。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              issues: { type: "array" },
              summary: { type: "string" },
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
            },
          },
        },
        {
          type: "agent",
          id: "fix1",
          agent: "vllm",
          deps: ["review1"],
          guard: "deps.review1.output.verdict != 'approved'",
          prompt:
            "审查者(第 1 轮)提出了修改意见,请逐条修复,不要引入声明范围之外的改动。审查结果:\n{{deps.review1.output}}\n完成后简述修改。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "review2",
          agent: "vllm",
          deps: ["fix1", "review1"],
          guard: "deps.review1.output.verdict != 'approved'",
          prompt:
            "开发者已按第 1 轮意见修复。请再次审查当前 workspace 改动(git diff),对照规格给出结论。第 1 轮已提出且已修复的问题不要重复提:\n{{deps.review1.output}}\n\n规格:\n{{inputs.spec}}\n声明范围(glob):{{inputs.scopeGlobs}}",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              issues: { type: "array" },
              summary: { type: "string" },
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
            },
          },
        },
        {
          type: "agent",
          id: "fix2",
          agent: "vllm",
          deps: ["review2", "review1"],
          guard:
            "deps.review1.output.verdict != 'approved' && deps.review2.output.verdict != 'approved'",
          prompt:
            "审查者(第 2 轮)提出了修改意见,请逐条修复,不要引入声明范围之外的改动。审查结果:\n{{deps.review2.output}}\n完成后简述修改。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "review3",
          agent: "vllm",
          deps: ["fix2", "review1", "review2"],
          guard:
            "deps.review1.output.verdict != 'approved' && deps.review2.output.verdict != 'approved'",
          prompt:
            "开发者已按第 2 轮意见修复。这是最后一轮自动审查(第 3 轮),请对照规格给出结论。前两轮已提出且已修复的问题不要重复提:\n第 1 轮:{{deps.review1.output}}\n第 2 轮:{{deps.review2.output}}\n\n规格:\n{{inputs.spec}}\n声明范围(glob):{{inputs.scopeGlobs}}",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              issues: { type: "array" },
              summary: { type: "string" },
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
            },
          },
        },
        {
          type: "agent",
          id: "reviewEscalate",
          agent: "claude-code",
          deps: ["review3", "review1", "review2"],
          guard:
            "deps.review1.output.verdict != 'approved' && deps.review2.output.verdict != 'approved' && deps.review3.output.verdict != 'approved'",
          prompt:
            "自动代码审查已进行 3 轮仍未通过批准。这是一个无人值守的自动化流水线,没有人工审批步骤——你需要自己做出最终判断,不能等待或假设有人会介入。\n\n仔细阅读三轮审查的完整意见,自己判断:\n- 如果剩下的问题都是次要的(风格、命名、非关键的建议性意见),且核心功能和范围都正确,判定 choice=approve,在 summary 里如实说明还有哪些次要问题未解决。\n- 如果存在真实的功能缺陷、越界改动、或未解决的关键问题,判定 choice=reject,在 summary 里清楚说明具体原因,这会让整个工作项失败并需要人工重新介入(通过 tracker 页面,不是在这个 DAG 里等待)。\n\n第 1 轮审查结果:\n{{deps.review1.output}}\n\n第 2 轮审查结果:\n{{deps.review2.output}}\n\n第 3 轮审查结果:\n{{deps.review3.output}}",
          output_schema: {
            type: "object",
            required: ["choice", "summary"],
            properties: {
              choice: { type: "string", enum: ["approve", "reject"] },
              summary: { type: "string" },
            },
          },
        },
        {
          type: "agent",
          id: "gateStack",
          agent: "vllm",
          deps: ["review1", "review2", "review3", "reviewEscalate"],
          guard:
            "inputs.gateMode == 'stack' && ((deps.review1.output.verdict == 'approved') || (deps.review2.output.verdict == 'approved') || (deps.review3.output.verdict == 'approved') || (deps.reviewEscalate.output.choice == 'approve'))",
          prompt:
            "项目门禁模式为 stack。请在当前 workspace 运行完整的构建/lint/类型检查/测试(使用项目已有的 build/lint/typecheck/test 脚本,若某项不存在可跳过并在 summary 中说明),给出结论。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              summary: { type: "string" },
              verdict: { type: "string", enum: ["pass", "fail"] },
            },
          },
        },
        {
          type: "agent",
          id: "gateTests",
          agent: "vllm",
          deps: ["review1", "review2", "review3", "reviewEscalate"],
          guard:
            "inputs.gateMode == 'tests-only' && ((deps.review1.output.verdict == 'approved') || (deps.review2.output.verdict == 'approved') || (deps.review3.output.verdict == 'approved') || (deps.reviewEscalate.output.choice == 'approve'))",
          prompt:
            "项目门禁模式为 tests-only。请在当前 workspace 只运行测试套件(不需要 build/lint/typecheck),给出结论。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              summary: { type: "string" },
              verdict: { type: "string", enum: ["pass", "fail"] },
            },
          },
        },
        {
          type: "agent",
          id: "gateNone",
          agent: "vllm",
          deps: ["review1", "review2", "review3", "reviewEscalate"],
          guard:
            "inputs.gateMode == 'none' && ((deps.review1.output.verdict == 'approved') || (deps.review2.output.verdict == 'approved') || (deps.review3.output.verdict == 'approved') || (deps.reviewEscalate.output.choice == 'approve'))",
          prompt:
            "项目门禁模式为 none,跳过质量门禁检查。直接确认并返回 verdict=pass,summary 写 'gate skipped (mode=none)'。不要运行任何命令。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              summary: { type: "string" },
              verdict: { type: "string", enum: ["pass", "fail"] },
            },
          },
        },
        {
          type: "agent",
          id: "diffAudit",
          agent: "vllm",
          deps: [
            "gateStack",
            "gateTests",
            "gateNone",
            "review1",
            "review2",
            "review3",
            "reviewEscalate",
          ],
          guard:
            "(deps.review1.output.verdict == 'approved') || (deps.review2.output.verdict == 'approved') || (deps.review3.output.verdict == 'approved') || (deps.reviewEscalate.output.choice == 'approve')",
          prompt:
            "这是提交前最终的改动范围审计(确定性 scope check,不是代码质量判断)。用 `git diff --name-only`(对比 base 分支)列出当前 workspace 的所有改动文件,并与声明的改动范围逐一核对:\n\n声明范围(glob 模式):{{inputs.scopeGlobs}}\n\n任何不匹配声明范围的文件都属于越界(out_of_scope)。逐个文件严格判断,不要主观放宽或以'看起来合理'为由放过越界文件。给出结构化结论:verdict 为 in_scope 或 out_of_scope,offendingFiles 列出所有越界文件路径(没有则为空数组),summary 简述改动文件总数与判断依据。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              summary: { type: "string" },
              verdict: { type: "string", enum: ["in_scope", "out_of_scope"] },
              offendingFiles: { type: "array" },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["spec", "workspaceId", "gateMode", "scopeGlobs"],
      properties: {
        spec: {
          type: "string",
          description: "The work-item requirement/spec text.",
        },
        gateMode: {
          type: "string",
          enum: ["stack", "tests-only", "none"],
          description: "Quality gate mode from project_repos.gateMode.",
        },
        scopeGlobs: {
          type: "array",
          items: { type: "string" },
          description:
            "Glob patterns declaring the allowed change scope for this work item.",
        },
        workspaceId: {
          type: "string",
          description: "V3 host-native workspace id to develop in.",
        },
      },
    },
  },
  {
    name: "sdlc-verify",
    family: "sdlc",
    tags: ["verifying 相位", "证据必附"],
    description:
      "Sprint 集成验证:各仓全量测试(parallel_over)+ 集成场景逐个实测;终态由 brain 读取本产物在 tracker 建 from-audit 单(R4c 前无确定性建单通道)。",
    changeNote:
      "R4a.1 硬化至 Profile A:plan/integration/report 全部显式 {{inputs.*}}/{{deps.<id>.output}} 插值;report 节点带 enum verdict(GREEN/RED)output_schema,取代旧版用一个 LLM 'audit' 节点冒充确定性建单的写法;交付尾(自动建 from-audit 单)移出 DAG,归 brain 回合(R4c 前无回写建单工具,r4 doc §1.1/§4.3)。注:parallel_over 的 fanout 子节点今天没有把 items_from 选中的单项通过任何 {{}} 通道注入 body prompt(v3-dispatcher.ts buildInterpolationContext 只暴露 inputs/deps,没有 item 绑定)——fanout body 因此只能引用整体 {{inputs.repos}},这是引擎现状的真实限制,不在本任务改动范围(不动 v3-dispatcher.ts)。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "plan",
          agent: DEV,
          deps: [],
          prompt:
            "汇总本次验证覆盖的仓库清单,并给出验证顺序建议(不做实际测试,只做规划):\n\n{{inputs.repos}}",
        },
        {
          type: "parallel_over",
          id: "fanout-tests",
          deps: ["plan"],
          items_from: "inputs.repos",
          body: {
            type: "agent",
            agent: DEV,
            prompt:
              "在当前 workspace 对仓库清单({{inputs.repos}})中的一个仓库运行该仓库的全量测试套件,给出该仓库名、通过/失败结论与关键证据。",
            workspace: "{{inputs.workspaceId}}",
            output_schema: {
              type: "object",
              required: ["repo", "verdict"],
              properties: {
                repo: { type: "string" },
                verdict: { type: "string", enum: ["GREEN", "RED"] },
                evidence: { type: "string" },
              },
            },
          },
        },
        {
          type: "agent",
          id: "integration",
          agent: DEV,
          deps: ["fanout-tests"],
          prompt:
            "基于以下测试计划场景,在当前 workspace 逐个执行集成实测(端到端行为,不是仓库内单测):\n\n{{inputs.scenarios}}\n\n对每个场景给出通过/不通过结论与证据。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "report",
          agent: REVIEW,
          deps: ["integration"],
          prompt:
            "综合集成实测结果,给出本次验证的最终结论(GREEN=全部通过,RED=存在失败)。\n\n集成实测结果:\n{{deps.integration.output}}\n\nRED 时在 failures 中逐条列出失败场景;本节点不在 DAG 内建单,由 brain 读取本产物后在 tracker 建 from-audit 单。",
          output_schema: {
            type: "object",
            required: ["verdict"],
            properties: {
              verdict: { type: "string", enum: ["GREEN", "RED"] },
              failures: { type: "array" },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["repos", "workspaceId"],
      properties: {
        repos: { type: "array", items: { type: "string" } },
        scenarios: { type: "array", items: { type: "string" } },
        workspaceId: { type: "string" },
      },
    },
  },
  {
    name: "sdlc-gap-analysis",
    family: "sdlc",
    tags: ["目标审计相位", "output_schema"],
    description:
      "目标审计:只看 goal+diff+验证日志(收集节点注入,不在节点内自行提取);证据 schema 反奉承;≤3 轮 guard 展开,超限升级人类。",
    changeNote:
      "R4a.1 硬化至 Profile A:直接采用 101 生产 sdlc-audit v2 的三轮展开模式,新增 collect(材料汇总)与 escalate(human_gate)首尾节点;metrics[].id 锚定 sprint-doc 的 M 编号(extract-goal-metrics 已存在,作为输入注入而非节点内提取)。注:audit2/audit3 刻意不重复生产 sdlc-audit v2 里 audit2 引用 deps.audit1(非其自身直接依赖 close1)的写法——v3-reconciler.ts 的 buildGuardContext 只解析节点自身 deps 数组,引用非直接依赖会解析为 undefined;本条目改用 reconciler 自带的级联跳过(全部直接依赖都被跳过时自动跳过,见 v3-reconciler.ts evaluateGuardsAndSkip 的 allDepsSkipped 分支),audit2/audit3 因此不需要也不应该再带 guard。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "collect",
          agent: DEV,
          deps: [],
          prompt:
            "收集本轮目标审计所需材料,不做判断,只汇总整理。\n\n目标:\n{{inputs.goal}}\n\n已提取的目标指标(M 编号,来自 extract-goal-metrics):\n{{inputs.goalMetrics}}\n\n本次改动的 diff 摘要(来自 workspaceDiff):\n{{inputs.diffSummary}}",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "audit1",
          agent: REVIEW,
          deps: ["collect"],
          prompt:
            "对目标做审计:仅依据代码/证据判断目标是否真正达成(不依赖任务清单)。\n\n目标:\n{{inputs.goal}}\n\n目标指标(M 编号):\n{{inputs.goalMetrics}}\n\n已收集材料:\n{{deps.collect.output}}\n\n给出结构化结论,gaps 与 metrics 逐项列出(metrics[].id 对应上面的 M 编号)。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict"],
            properties: {
              verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
              gaps: { type: "array" },
              metrics: { type: "array" },
            },
          },
        },
        {
          type: "agent",
          id: "close1",
          agent: DEV,
          deps: ["audit1"],
          guard: "deps.audit1.output.verdict != 'NO_GAPS'",
          prompt:
            "目标审计发现未达成的 gap,请在当前 workspace 补齐,使目标真正达成。\n\n{{deps.audit1.output}}\n\n只补齐这些 gap,不引入无关改动。完成后简述改了什么。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "audit2",
          agent: REVIEW,
          deps: ["close1"],
          prompt:
            "开发者已按第 1 轮审计补齐 gap。再次做目标审计(核实证据)。\n\n目标:\n{{inputs.goal}}\n目标指标:\n{{inputs.goalMetrics}}\n\n给出结构化结论。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict"],
            properties: {
              verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
              gaps: { type: "array" },
              metrics: { type: "array" },
            },
          },
        },
        {
          type: "agent",
          id: "close2",
          agent: DEV,
          deps: ["audit2"],
          guard: "deps.audit2.output.verdict != 'NO_GAPS'",
          prompt:
            "第 2 轮审计仍有 gap,请补齐。\n\n{{deps.audit2.output}}\n\n只补这些。完成后简述。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "audit3",
          agent: REVIEW,
          deps: ["close2"],
          prompt:
            "第 3 轮(最终)目标审计。核实证据后给最终 verdict。\n\n目标:\n{{inputs.goal}}\n目标指标:\n{{inputs.goalMetrics}}",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict"],
            properties: {
              verdict: { type: "string", enum: ["NO_GAPS", "GAPS_FOUND"] },
              gaps: { type: "array" },
              metrics: { type: "array" },
            },
          },
        },
        {
          type: "human_gate",
          id: "escalate",
          deps: ["audit3"],
          guard: "deps.audit3.output.verdict != 'NO_GAPS'",
          prompt:
            "3 轮目标审计仍未通过(GAPS_FOUND)。请人工裁决。\n\n第 3 轮结论:\n{{deps.audit3.output}}",
          options: ["defer", "force-accept", "rework"],
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["goal", "workspaceId"],
      properties: {
        goal: { type: "string" },
        goalMetrics: { type: "array" },
        diffSummary: { type: "string" },
        workspaceId: { type: "string" },
      },
    },
  },
  {
    name: "sdlc-promote",
    family: "sdlc",
    tags: ["promoting 相位", "顺序锁"],
    description:
      "Phase G promotion: merge the sprint branch into the base branch with a merge-commit (preserving the sprint boundary). Idempotent: if the sprint branch has no commits ahead of base, skip. The vLLM agent performs the git operations in the workspace.",
    changeNote:
      "此条目此前是种子自行编写的 4 节点 pr→ci→merge→cleanup 死代码——`workflow-templates-seed.ts` 撞名机制下从未真正写入生产(r4 doc §1.2)。现替换为 101 生产 v1 的真实 dag(brain 于 2026-07-04 所建,单节点 vllm 微工作流,内含幂等 COMMITS_AHEAD 检查 + merge-commit 保留 sprint 边界 + 冲突时停止不自动解决,run 实绩 done 2 次)。这份内容是从生产只读查询取得,不是本文件原创设计——本表 4 节点方案(pr/ci/merge/cleanup 全部越权承诺 worker 做不到的事)已判定不如生产的 1 节点方案,弃用。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "promote",
          agent: "vllm",
          deps: [],
          prompt:
            '你是发布工程师,执行 Phase G 晋升:把 sprint 分支以 merge-commit 合入 base 分支。用 Bash 在当前 workspace 的 git 仓库操作:\n1. sprintBranch = {{inputs.sprintBranch}} ; baseBranch = {{inputs.baseBranch}}\n2. git fetch origin\n3. 幂等检查:COMMITS_AHEAD=$(git rev-list --count origin/{{inputs.baseBranch}}..origin/{{inputs.sprintBranch}})。若为 0,说明无需晋升(sprint 分支不领先 base),直接报告 already-promoted 并结束,不做任何操作。\n4. 若 >0:git checkout {{inputs.baseBranch}} && git merge --no-ff origin/{{inputs.sprintBranch}} -m "Promote sprint {{inputs.sprintBranch}} into {{inputs.baseBranch}}"(保留 sprint 边界的 merge-commit)。若有冲突,不要自动解决,报告冲突并停止(顺序合并红线:永不自动解冲突)。\n5. 成功后 git push origin {{inputs.baseBranch}}。\n报告:COMMITS_AHEAD 数、是否晋升、merge-commit sha 或 skip 原因、是否有冲突。绝不 force push,绝不自动解冲突。',
          workspace: "{{inputs.workspaceId}}",
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["workspaceId", "sprintBranch", "baseBranch"],
      properties: {
        baseBranch: { type: "string" },
        workspaceId: { type: "string" },
        sprintBranch: { type: "string" },
      },
    },
  },
  {
    name: "sdlc-ui-build",
    family: "sdlc",
    tags: ["UI track", "Foundry 设计系统"],
    description:
      "UI 原型流水线:ui-spec 解析 → 屏并行生成(vLLM,Foundry token 硬约束/禁 emoji)→ 设计系统 lint → 修复 → 跨屏一致性评审;入库 design 归 brain 尾(跨应用凭据只在网关/brain 层)。",
    changeNote:
      "R4a.1 硬化至 Profile A:parse 节点显式产出 output_schema{screens[]},parallel_over 的 items_from 从常量 inputs.screens 改为 deps.parse.output.screens(真实依赖上游解析结果,而不是要求调用方预先拆好屏清单);lint 补 enum verdict(CLEAN/ISSUES_FOUND)output_schema 使其可被 guard 消费;review 补 findings[]{screen,kind,severity} 结构化输出;publish(入库 design)节点删除,归 brain 尾(memory 101-mcp-publish-channel:发布通道已验证,只在网关/brain 层)。lint 仍是 LLM 冒充确定性检查,诚实标注为 'LLM lint'。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "parse",
          agent: DEV,
          deps: [],
          prompt:
            "解析以下 ui-spec,列出全部待生成的屏清单(逐屏给出简要说明):\n\n{{inputs.uiSpec}}",
          output_schema: {
            type: "object",
            required: ["screens"],
            properties: {
              screens: { type: "array", items: { type: "string" } },
            },
          },
        },
        {
          type: "parallel_over",
          id: "fanout-screens",
          deps: ["parse"],
          items_from: "deps.parse.output.screens",
          body: {
            type: "agent",
            agent: DEV,
            prompt:
              "在当前 workspace 按 Foundry 设计系统 token 硬约束生成单屏原型 HTML,禁止使用任何 emoji 作图标(只用 Tabler Icons)。设计系统:{{inputs.designSystemId}}\n\nui-spec 全文:\n{{inputs.uiSpec}}",
            workspace: "{{inputs.workspaceId}}",
          },
        },
        {
          type: "agent",
          id: "lint",
          agent: REVIEW,
          deps: ["fanout-screens"],
          prompt:
            "对生成的各屏 HTML 做设计系统 lint 校验(token 存在性、禁 emoji 扫描等)。这是 LLM lint,不是确定性检查。给出逐屏结构化 findings。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "findings"],
            properties: {
              verdict: { type: "string", enum: ["CLEAN", "ISSUES_FOUND"] },
              findings: { type: "array" },
            },
          },
        },
        {
          type: "agent",
          id: "fix",
          agent: DEV,
          deps: ["lint"],
          guard: "deps.lint.output.verdict != 'CLEAN'",
          prompt:
            "按 lint 发现的问题修复各屏 HTML:\n\n{{deps.lint.output.findings}}\n\n只修复这些问题,不引入无关改动。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "review",
          agent: REVIEW,
          deps: ["fix", "lint"],
          prompt:
            "跨屏一致性评审:检查各屏之间的视觉/交互一致性(色彩/间距/组件用法),给出结构化 findings(每条含 screen/kind/severity)。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["findings"],
            properties: {
              findings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    screen: { type: "string" },
                    kind: { type: "string" },
                    severity: { type: "string" },
                  },
                },
              },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["uiSpec", "workspaceId"],
      properties: {
        uiSpec: { type: "string" },
        designSystemId: { type: "string" },
        workspaceId: { type: "string" },
      },
    },
  },

  // ── 轻量族 · 短流程 ────────────────────────────────────────────────────────
  {
    name: "quick-task",
    family: "light",
    tags: ["无 sprint 任务", "auto 模式"],
    description:
      "跳过规划直达实施:dev · qa(output_schema)· fix(guard)· review(1 轮,output_schema)。单工作项小改动的默认通道;交付(PR)归 brain 尾。",
    changeNote:
      "R4a.1 硬化至 Profile A:全部节点显式 {{inputs.spec}}/{{inputs.scopeGlobs}}/{{inputs.workspaceId}} 插值;qa/review 补 enum verdict output_schema;pr 节点删除,归 brain 尾。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: DEV,
          deps: [],
          prompt:
            "你是开发者。在当前 workspace 完成以下开发规格(跳过规划直达实施):\n\n{{inputs.spec}}\n\n只改动声明范围内的文件,范围(glob):{{inputs.scopeGlobs}}\n完成后简述改了哪些文件。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "qa",
          agent: DEV,
          deps: ["dev"],
          prompt: "运行测试验证上面的改动,给出结论。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              verdict: { type: "string", enum: ["pass", "fail"] },
              summary: { type: "string" },
            },
          },
        },
        {
          type: "agent",
          id: "fix",
          agent: DEV,
          deps: ["qa"],
          guard: "deps.qa.output.verdict != 'pass'",
          prompt:
            "QA 发现问题,请修复:\n\n{{deps.qa.output}}\n\n只修复这些问题,不引入声明范围之外的改动。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "review",
          agent: REVIEW,
          deps: ["fix", "qa"],
          prompt:
            "审查当前 workspace 改动(1 轮),对照规格判断:\n\n{{inputs.spec}}\n\n声明范围(glob):{{inputs.scopeGlobs}}\n如果改动越界,verdict 必须是 changes_requested。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
              summary: { type: "string" },
              issues: { type: "array" },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["spec", "workspaceId"],
      properties: {
        spec: { type: "string" },
        scopeGlobs: { type: "array", items: { type: "string" } },
        workspaceId: { type: "string" },
      },
    },
  },
  {
    name: "hotfix",
    family: "light",
    tags: ["缺陷 / 生产问题", "from-audit"],
    description:
      "缺陷热修:先写复现失败测试(必须先红,附失败输出证据)· 修复 · 全量回归 · 评审。交付(PR)归 brain 尾。",
    changeNote:
      'R4a.1 硬化至 Profile A:red 节点 output_schema 强制附 red_evidence 字段("必须先红"从口号变字段);regress/review 补 output_schema;pr 节点删除,归 brain 尾。',
    dag: {
      nodes: [
        {
          type: "agent",
          id: "red",
          agent: DEV,
          deps: [],
          prompt:
            "你是开发者。先写一个能复现该缺陷的失败测试(必须先红),不要修复代码。\n\n缺陷描述:\n{{inputs.spec}}\n\n运行该测试,把失败输出作为证据附上。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["red_evidence"],
            properties: {
              red_evidence: { type: "string" },
            },
          },
        },
        {
          type: "agent",
          id: "fix",
          agent: DEV,
          deps: ["red"],
          prompt:
            "复现测试已确认为红。请修复缺陷使其变绿。\n\n复现证据:\n{{deps.red.output.red_evidence}}\n\n只改动声明范围内的文件,范围(glob):{{inputs.scopeGlobs}}",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "regress",
          agent: DEV,
          deps: ["fix"],
          prompt: "运行全量回归测试,确认修复未引入新问题。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              verdict: { type: "string", enum: ["pass", "fail"] },
              summary: { type: "string" },
            },
          },
        },
        {
          type: "agent",
          id: "review",
          agent: REVIEW,
          deps: ["regress"],
          prompt:
            "审查当前 workspace 的缺陷修复改动,对照缺陷描述判断:\n\n{{inputs.spec}}\n\n声明范围(glob):{{inputs.scopeGlobs}}\n回归结果:\n{{deps.regress.output}}",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "summary"],
            properties: {
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
              summary: { type: "string" },
              issues: { type: "array" },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["spec", "workspaceId"],
      properties: {
        spec: { type: "string" },
        scopeGlobs: { type: "array", items: { type: "string" } },
        workspaceId: { type: "string" },
      },
    },
  },
  {
    name: "docs-task",
    family: "light",
    tags: ["文档类型", "content 应用"],
    description:
      "文档任务:draft(读代码/产物)· 事实核查评审(output_schema)· fix(guard)。发布到 content 归 brain 尾(NFM 约束在 brain prompt)。",
    changeNote:
      "R4a.1 硬化至 Profile A:draft/factcheck/fix 显式 {{inputs.*}}/{{deps.*.output}} 插值;factcheck 补 enum verdict(accurate/inaccurate)output_schema;publish 节点删除,归 brain 尾。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "draft",
          agent: DEV,
          deps: [],
          prompt:
            "你是文档撰写者。基于以下规格,只读当前 workspace 相关代码/产物,撰写文档草稿:\n\n{{inputs.spec}}\n\n不要修改任何实现代码,只产出文档正文。",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "factcheck",
          agent: REVIEW,
          deps: ["draft"],
          prompt:
            "事实核查上面撰写的文档草稿:核对代码路径/API/字段名是否与当前 workspace 实际一致。给出结构化 findings。",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            required: ["verdict", "findings"],
            properties: {
              verdict: { type: "string", enum: ["accurate", "inaccurate"] },
              findings: { type: "array" },
            },
          },
        },
        {
          type: "agent",
          id: "fix",
          agent: DEV,
          deps: ["factcheck"],
          guard: "deps.factcheck.output.verdict != 'accurate'",
          prompt:
            "事实核查发现问题,请修正文档:\n\n{{deps.factcheck.output.findings}}\n\n只修正这些问题。",
          workspace: "{{inputs.workspaceId}}",
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["spec", "workspaceId"],
      properties: {
        spec: { type: "string" },
        workspaceId: { type: "string" },
      },
    },
  },
  {
    name: "spike-research",
    family: "light",
    tags: ["调研类型", "spike-report"],
    description:
      "调研任务:只读 explore · 结构化报告(结论/证据/选项对比/建议);无代码合入,本来就无交付尾。",
    changeNote:
      "R4a.1 硬化至 Profile A:explore 补 workspace 贯穿;report 显式 {{deps.explore.output}} 插值 + output_schema(conclusion/evidence/options/recommendation)。改动最小,因为本来就没有交付尾要移除。",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "explore",
          agent: DEV,
          deps: [],
          prompt:
            "你是调研者。只读地探索当前 workspace/代码库,围绕以下调研问题收集证据(不要修改任何文件):\n\n{{inputs.spec}}",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "report",
          agent: REVIEW,
          deps: ["explore"],
          prompt:
            "基于上面的探索结果,撰写结构化调研报告(结论/证据/选项对比/建议)。\n\n探索结果:\n{{deps.explore.output}}",
          output_schema: {
            type: "object",
            required: ["conclusion", "recommendation"],
            properties: {
              conclusion: { type: "string" },
              evidence: { type: "array" },
              options: { type: "array" },
              recommendation: { type: "string" },
            },
          },
        },
      ],
    },
    inputSchema: {
      type: "object",
      required: ["spec", "workspaceId"],
      properties: {
        spec: { type: "string" },
        workspaceId: { type: "string" },
      },
    },
  },
];
