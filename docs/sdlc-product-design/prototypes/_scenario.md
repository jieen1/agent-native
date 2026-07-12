# 原型共享演示数据（所有屏必须一致引用）

- 项目：**支付中心**（key=PAY，仓库 payhub，baseBranch=main，ciMode=none，gateMode=tests-only）
- 当前 Sprint：**Sprint 3 · 计费对账与账单导出**，phase=**executing**，分支 sprint-3
  - 目标：商户可自助导出账单并与对账单一致
  - 签核：plan-signoff ✓（7-08 Steve）· ui-signoff ✓（7-09）· design-signoff ✓（7-09）
- 工作项（itemKey · 标题 · 类型 · 优先级 · 状态）：
  - PAY-201 账单导出 CSV 接口 · 需求 · P0 · 实施中（run_8f3k21 dev 节点运行中 3m42s）
  - PAY-202 对账报表汇总页 · 需求 · P1 · 等待依赖（blocked-by PAY-201）
  - PAY-203 金额四舍五入精度错误 · 缺陷 · P0 · 失败（hotfix run permanent 失败：gitRemote 认证失败）→ 待人工重派
  - PAY-204 账单导出页 UI · 需求 · P1 · 已合入（PR #86 merged，含 ui-spec S2 屏）
  - PAY-198 report 汇总缺 pow 字段 · from-audit · P0 · 测试中（阶段子集 实施→测试）
  - PAY-190 导出格式调研 CSV vs XLSX · 调研 · P2 · 已交付（spike-report v1）
- Sprint 2（上一个）：phase=done，8 项全交付，verify 首次通过率 75%，audit 1 轮 NO_GAPS
- 运行：
  - run_8f3k21 · sdlc-issue-pipeline@v4 · running · 节点 dev(运行中)→qa→reviewer→gatekeeper→diff-audit→pr→ci→merge
  - run_7d2m90 · sdlc-verify@v2 · done(RED→已建 PAY-198)
  - run_9a1x33 · sdlc-ui-build@v1 · done（4 屏原型入库 design:dsg_42）
  - run_6c8p17 · hotfix@v3 · failed（errorClass=permanent）
- Brain：线程 **Sprint 3 lead**（引擎 claude-code · sonnet-4-6 · 上下文 41%/200k · 槽 1/2）
  - 兜底引擎 sdk-vllm(qwen3.6) 健康；纪律指标：workflowRun 12 次 · 直改告警 0
- 健康：vLLM ●正常(9000, qwen3.6, 42ms) · CC ●已登录 · 调度器 ●运行中 · Brain 槽 1/2
- 审批/收件箱示例：
  - 待批：Sprint 4 plan-signoff（判据 2/3：缺 test-plan 产物）
  - 裁决：PAY-203 升级（评审 3 次超限）· 通知：Sprint 3 verify RED→已自动建单 PAY-198
- 度量（Sprint 3 至今）：环节中位耗时 dev 14m · qa 6m · reviewer 9m · gatekeeper 4m；
  token 今日 812k（vLLM 92%）；失败归因：prompt 3 · tool 2 · engine 1 · template 1 · harness 0
- 人员：Steve（人，头像 S）；agent 行为者：dev=vllm/qwen3.6、reviewer=sonnet
