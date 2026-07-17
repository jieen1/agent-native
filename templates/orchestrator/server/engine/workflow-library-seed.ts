/**
 * S8 workflow library seed data (04-orchestrator.md §4 + §13, 02-workflows.md
 * §3.10 template-family table): the 9 built-in DAG templates (5 `sdlc-*` +
 * 4 light-family) the workflow library page groups cards under. Exported as
 * plain data (not inserted directly here) so:
 *   - `workflow-templates-seed.ts` (the boot plugin) can upsert it against a
 *     real Postgres connection, and
 *   - `workflow-library-seed.spec.ts` can run every entry's `dag` through the
 *     real `validateDag()` with zero DB — proving the seed is actually
 *     save-able before it ever reaches a boot-time try/catch that would
 *     otherwise swallow a validation failure silently.
 *
 * DAG shapes here are deliberately real (valid nodes/deps/loop/parallel_over)
 * but are NOT a literal transcription of the s8 prototype's hand-drawn mini
 * SVGs — those are illustrative mockup art, not a data contract. The library
 * page's DAG thumbnail renders whatever `dag.nodes` actually contains, so a
 * real (if modest) graph is the correct seed, not a pixel replica.
 */

export type WorkflowFamily = "sdlc" | "light";

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
  // ── SDLC 族 · 内置 ─────────────────────────────────────────────────────────
  {
    name: "sdlc-issue-pipeline",
    family: "sdlc",
    tags: ["sprint 开发项", "TDD 红先行"],
    description:
      "单工作项实施流水线：dev · qa · review(≤3) · gate · diff-audit · PR · CI · 顺序合入 sprint 分支",
    changeNote: "初始种子版本导入 9 套内置工作流模板（04 §13）",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: DEV,
          prompt: "实现工作项变更，遵循 TDD 红先行",
          deps: [],
        },
        {
          type: "agent",
          id: "qa",
          agent: DEV,
          prompt: "运行全量测试并采集证据",
          deps: ["dev"],
        },
        {
          type: "agent",
          id: "reviewer",
          agent: REVIEW,
          prompt: "只审 diff，输出结构化评审意见（通过/需修改）",
          deps: ["qa"],
        },
        {
          type: "loop",
          id: "review-loop",
          body: "reviewer",
          until: "deps.reviewer.output.approved == true",
          max_iterations: 3,
          deps: ["qa"],
        },
        {
          type: "human_gate",
          id: "gate",
          prompt: "确认评审通过后放行合并",
          deps: ["review-loop"],
        },
        {
          type: "agent",
          id: "diff-audit",
          agent: REVIEW,
          prompt: "审计 diff 是否越界，核对证据 schema",
          deps: ["gate"],
        },
        {
          type: "agent",
          id: "pr",
          agent: DEV,
          prompt: "顺序合入 sprint 分支并提交 PR",
          deps: ["diff-audit"],
        },
      ],
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sdlc-verify",
    family: "sdlc",
    tags: ["verifying 相位", "证据必附"],
    description:
      "Sprint 集成验证：各仓全量测试 (parallel_over) + 集成场景逐个实测；RED 自动建 from-audit 单",
    changeNote: "初始种子版本导入 9 套内置工作流模板（04 §13）",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "start",
          agent: DEV,
          prompt: "汇总待验证仓库清单",
          deps: [],
        },
        {
          type: "parallel_over",
          id: "fanout-tests",
          deps: ["start"],
          items_from: "inputs.repos",
          body: {
            type: "agent",
            agent: DEV,
            prompt: "对单个仓库运行全量测试套件",
          },
        },
        {
          type: "agent",
          id: "integration",
          agent: DEV,
          prompt: "集成场景逐个实测",
          deps: ["fanout-tests"],
        },
        {
          type: "agent",
          id: "audit",
          agent: REVIEW,
          prompt: "RED 结果自动生成 from-audit 单",
          deps: ["integration"],
        },
      ],
    },
    inputSchema: {
      type: "object",
      properties: { repos: { type: "array", items: { type: "string" } } },
      required: ["repos"],
    },
  },
  {
    name: "sdlc-gap-analysis",
    family: "sdlc",
    tags: ["目标审计相位", "output_schema"],
    description:
      "目标审计：只看 goal+diff+验证日志；证据 schema 反奉承；≤3 轮，超限升级人类",
    changeNote: "初始种子版本导入 9 套内置工作流模板（04 §13）",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "collect",
          agent: DEV,
          prompt: "收集 goal、diff、验证日志",
          deps: [],
        },
        {
          type: "agent",
          id: "audit",
          agent: REVIEW,
          prompt: "目标审计：比对 goal 与实现，输出 GAPS/NO_GAPS",
          deps: ["collect"],
          output_schema: {
            type: "object",
            properties: { verdict: { type: "string" } },
            required: ["verdict"],
          },
        },
        {
          type: "loop",
          id: "audit-loop",
          body: "audit",
          until: "deps.audit.output.verdict == 'NO_GAPS'",
          max_iterations: 3,
          deps: ["collect"],
        },
        {
          type: "human_gate",
          id: "escalate",
          prompt: "超过 3 轮未通过，升级人类裁决",
          deps: ["audit-loop"],
        },
      ],
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sdlc-promote",
    family: "sdlc",
    tags: ["promoting 相位", "顺序锁"],
    description:
      "拓扑序晋升：sprint-end PR · CI · merge-commit 合入 base · 删 sprint 分支；幂等可重跑",
    changeNote: "初始种子版本导入 9 套内置工作流模板（04 §13）",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "pr",
          agent: DEV,
          prompt: "发起 sprint-end PR",
          deps: [],
        },
        {
          type: "agent",
          id: "ci",
          agent: REVIEW,
          prompt: "等待并核验 CI 结果",
          deps: ["pr"],
        },
        {
          type: "agent",
          id: "merge",
          agent: DEV,
          prompt: "合并到 base 分支（merge-commit，幂等）",
          deps: ["ci"],
        },
        {
          type: "agent",
          id: "cleanup",
          agent: DEV,
          prompt: "删除 sprint 分支",
          deps: ["merge"],
        },
      ],
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sdlc-ui-build",
    family: "sdlc",
    tags: ["UI track", "Foundry 设计系统"],
    description:
      "UI 原型流水线：ui-spec 解析 · 屏并行生成 (vLLM) · 设计系统 lint · 一致性评审 · 入库 design",
    changeNote: "初始种子版本导入 9 套内置工作流模板（04 §13）",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "spec",
          agent: DEV,
          prompt: "解析 ui-spec",
          deps: [],
        },
        {
          type: "parallel_over",
          id: "screens",
          deps: ["spec"],
          items_from: "inputs.screens",
          body: {
            type: "agent",
            agent: DEV,
            prompt: "并行生成单屏原型（vLLM）",
          },
        },
        {
          type: "agent",
          id: "lint",
          agent: REVIEW,
          prompt: "设计系统 lint 校验",
          deps: ["screens"],
        },
        {
          type: "agent",
          id: "review",
          agent: REVIEW,
          prompt: "一致性评审",
          deps: ["lint"],
        },
        {
          type: "agent",
          id: "publish",
          agent: DEV,
          prompt: "入库 design",
          deps: ["review"],
        },
      ],
    },
    inputSchema: {
      type: "object",
      properties: { screens: { type: "array", items: { type: "string" } } },
      required: ["screens"],
    },
  },
  // ── 轻量族 · 短流程 ────────────────────────────────────────────────────────
  {
    name: "quick-task",
    family: "light",
    tags: ["无 sprint 任务", "auto 模式"],
    description:
      "跳过规划直达实施：dev · qa · review(1 轮) · PR。单工作项小改动的默认通道",
    changeNote: "初始种子版本导入 9 套内置工作流模板（04 §13）",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: DEV,
          prompt: "跳过规划直达实施",
          deps: [],
        },
        {
          type: "agent",
          id: "qa",
          agent: DEV,
          prompt: "运行测试",
          deps: ["dev"],
        },
        {
          type: "agent",
          id: "review",
          agent: REVIEW,
          prompt: "评审（1 轮）",
          deps: ["qa"],
        },
        {
          type: "agent",
          id: "pr",
          agent: DEV,
          prompt: "提交 PR",
          deps: ["review"],
        },
      ],
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hotfix",
    family: "light",
    tags: ["缺陷 / 生产问题", "from-audit"],
    description:
      "缺陷热修：先写复现失败测试（必须先红，附失败输出证据） · 修复 · 全量回归 · PR",
    changeNote: "初始种子版本导入 9 套内置工作流模板（04 §13）",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "red",
          agent: DEV,
          prompt: "先写复现失败测试（必须先红，附失败输出证据）",
          deps: [],
        },
        {
          type: "agent",
          id: "fix",
          agent: DEV,
          prompt: "修复缺陷",
          deps: ["red"],
        },
        {
          type: "agent",
          id: "regress",
          agent: DEV,
          prompt: "全量回归测试",
          deps: ["fix"],
        },
        {
          type: "agent",
          id: "pr",
          agent: DEV,
          prompt: "提交 PR",
          deps: ["regress"],
        },
      ],
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "docs-task",
    family: "light",
    tags: ["文档类型", "content 应用"],
    description:
      "文档任务：draft（读代码/产物） · 事实核查评审 · 发布到 content（NFM 约束）",
    changeNote: "初始种子版本导入 9 套内置工作流模板（04 §13）",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "draft",
          agent: DEV,
          prompt: "draft（读代码/产物）",
          deps: [],
        },
        {
          type: "agent",
          id: "factcheck",
          agent: REVIEW,
          prompt: "事实核查评审",
          deps: ["draft"],
        },
        {
          type: "agent",
          id: "publish",
          agent: DEV,
          prompt: "发布到 content（NFM 约束）",
          deps: ["factcheck"],
        },
      ],
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spike-research",
    family: "light",
    tags: ["调研类型", "spike-report"],
    description:
      "调研任务：只读 explore · 结构化报告（结论/证据/选项对比/建议）；无代码合入",
    changeNote: "初始种子版本导入 9 套内置工作流模板（04 §13）",
    dag: {
      nodes: [
        {
          type: "agent",
          id: "explore",
          agent: DEV,
          prompt: "只读 explore",
          deps: [],
        },
        {
          type: "agent",
          id: "report",
          agent: REVIEW,
          prompt: "结构化报告（结论/证据/选项对比/建议）",
          deps: ["explore"],
        },
      ],
    },
    inputSchema: { type: "object", properties: {} },
  },
];
