# i18n 一致性审查 — Orchestrator / Tracker / 框架文档本地化

> 目的:审查近期新增的 Brain 运行时切换、Sprint Studio、orchestrator 健康页/洞察页重设计等 UI
> 是否走了框架 i18n 机制,以及 `packages/core/docs/content` 的文档改动是否同步更新了 `locales/*`
> 本地化版本(CLAUDE.md 强制要求)。
>
> 方法:全部结论基于对 `templates/orchestrator`、`templates/tracker`、`packages/core/docs/content`、
> `scripts/guard-i18n-catalogs.ts` 的直接读码核实,file:line 与命中计数均为实测。日期 2026-07-19。

---

## 0. 一句话结论

**Orchestrator 有一套自造的 i18next 双语字典(`templates/orchestrator/app/lib/i18n.ts`),但只有
9/123 个 app 文件接入,近期新增的三大界面(Brain 控制台、健康页、洞察页)完全没接入、是纯硬编码
中文;Tracker 则连自造机制都没有,全仓库零 i18n,包括新的 Sprint Studio;两者用的都不是框架官方
`@agent-native/core/client/i18n`(`useT()` + `app/i18n/` catalog)机制,而框架的
`pnpm guard:i18n-catalogs` 因为只扫描 `app/i18n/` 目录,对 orchestrator/tracker 完全不生效,所以
这个缺口长期没被 guard 拦截。文档同步方面,`packages/core/docs/content` 下有 3 个文档家族在全部
10 个语言目录里都零翻译,`durable-background-runs.mdx` 10 个语言里只有 1 个语言有翻译。**

---

## 1. 项目现状:两套并存但都不是官方机制

严重度图例:🔴 P0(机制缺失/大面积硬编码) · 🟠 P1(机制存在但覆盖严重不足) · 🟡 P2(卫生/漂移)

- **框架官方 i18n 机制**记录在 `packages/core/docs/content/internationalization.mdx`:`useT()` +
  `app/i18n/index.ts` catalog(`en-US` 源 + 动态 import 的其他 locale),受 `pnpm guard:i18n-catalogs`
  校验。**14 个模板已经采用这套机制**并有 `app/i18n/index.ts`:
  analytics / assets / brain / calendar / chat / clips / content / design / dispatch / forms /
  macros / mail / plan / slides。

- **`templates/orchestrator`** **没有** `app/i18n/` 目录,而是在 `templates/orchestrator/app/lib/i18n.ts`
  里自建了一套基于 `i18next` + `react-i18next` 的中英双语字典(en/zh 两棵对称树,约 300+ key,默认语言
  `zh`,`localStorage` 持久化,而不是框架文档要求的 SQL `localization` 设置 +
  `get/set-localization-preference` action)。这套机制**完全游离于框架 i18n 规范之外**,且未在
  `templates/orchestrator/CLAUDE.md`(已读取全文确认)或 `docs/agent-native-alignment-audit.md` 的
  『受控偏离』清单中被记录为已决策的偏离——**是一个此前未被审计过的新 gap**。

- **`templates/tracker`** 全仓库搜索 `i18n|useT|react-i18next` **零命中**(此前的表面命中全部是
  `useTheme`/`useToast`/`useTriggerStage`/`useTransitionWorkItem` 等误报),没有任何语言切换能力。
  `templates/tracker/CLAUDE.md` 把 7 阶段状态机(待办→分析→设计→实施→测试→验收→交付)、work item
  type(需求/缺陷/任务/事故)等**业务枚举值**定死为中文,这部分按框架 i18n 文档『不翻译稳定标识符/
  枚举值/数据库值』的规则本身没问题;但页面上的按钮/标题/空状态/toast 提示等**界面文案**同样是硬编码
  中文,没有任何机制可以切到英文或其他语言。

| #   | 关注点                       | 现状(证据)                                                                                                                                 | 官方做法                                                                                                    | 影响                                                                                       | 级别 |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---- |
| I1  | orchestrator i18n 机制非官方 | `templates/orchestrator/app/lib/i18n.ts` 自造 i18next 双语字典(en/zh 对称树,~300+ key,默认 `zh`,`localStorage` 持久化);无 `app/i18n/` 目录 | `useT()` + `app/i18n/index.ts` catalog + SQL `localization` 偏好 + `get/set-localization-preference` action | 游离于框架规范;`pnpm guard:i18n-catalogs` 不覆盖;未在 CLAUDE.md / 对齐审计中登记为受控偏离 | 🟠   |
| I2  | tracker 无任何 i18n 机制     | 全仓库 `i18n\|useT\|react-i18next` 零命中(误报来自 `useTheme`/`useToast` 等)                                                               | 同上                                                                                                        | 界面文案 100% 硬编码中文,无法切换语言                                                      | 🔴   |
| I3  | 新页面绕过既有机制           | brain/health/insights 三大新界面 0 处接入 orchestrator 自造字典(详见第 2、4 节)                                                            | 新增/改动用户可见文案应走 i18n 机制                                                                         | 机制存在但新页面开发时未被要求接入,缺口持续扩大                                            | 🔴   |
| I4  | guard 覆盖盲区               | `scripts/guard-i18n-catalogs.ts` 的 `findCatalogDirs()`(:297-311 起)只扫各模板 `app/i18n/`                                                 | guard 应覆盖实际文案漂移                                                                                    | orchestrator/tracker 的硬编码中文与文档 locales 缺口都不会被拦下                           | 🟠   |

---

## 2. 发现一:该走 i18n 却硬编码的地方(逐项,已读码核实)

| 文件                                                                                                                                                                                                                                                                                                             | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 说明                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `templates/orchestrator/app/routes/brain.tsx`(近期新增的 Brain 控制台/大脑运行时切换页,约 2284 行)                                                                                                                                                                                                               | 全文件搜索中文字符命中 **136 处**;`from "@/lib/i18n"` / `useTranslation()` **0 处命中**。典型证据:第 43 行 `meta()` 页面标题硬编码 `` `${APP_TITLE} — 大脑` ``(无英文回退);第 682 行 `toast.success(\`大脑模型已切换为「${result.name}」。\`)`;第 713/725/728/737/741/756/760/771/774 行等一系列 `toast.error/success` 硬编码中文提示;第 815-825 行左侧栏标题"大脑会话""新建"按钮;第 835 行搜索框 placeholder "搜索会话(标题或 ID)…";第 1279-1298 行删除会话确认弹窗标题/正文/按钮全部硬编码中文 | 完全没接入 orchestrator 自己那套 i18next 字典                                           |
| `templates/orchestrator/app/routes/health.tsx`(健康页重设计)                                                                                                                                                                                                                                                     | 中文命中 **77 处**;`lib/i18n` **0 处命中**。第 43 行 `meta()` 标题硬编码 `` `${APP_TITLE} — 健康` ``;第 300/339 行"健康检查"标题;第 778/808 行侧栏卡片标题"健康""洞察"均直接硬编码在 JSX 里                                                                                                                                                                                                                                                                                                      | 不经过任何字典                                                                          |
| `templates/orchestrator/app/routes/insights.tsx`(洞察页重设计)                                                                                                                                                                                                                                                   | 中文命中 **29 处**;`lib/i18n` **0 处命中**。第 24 行标题硬编码"洞察";第 37-41 行 `KPI_ITEMS` 数组的 `label` 字段("run 成功率""中位 run 时长""token / run""schema 纠偏率""评审平均轮数")直接写死中文字符串常量                                                                                                                                                                                                                                                                                    | 无字典引用,连数据常量里的 label 也是硬编码                                              |
| orchestrator 路由级统计                                                                                                                                                                                                                                                                                          | 19 个 `app/routes/*.tsx` 里只有 `workspaces._index.tsx`、`settings.tsx`、`spawns._index.tsx` 这 **3 个(约 16%)** 真正 `import`/调用了 `useTranslation()`;其余 16 个路由(含 `_index.tsx` 首页看板、`agents._index.tsx`、`skills._index.tsx`、`extensions*.tsx`、`runs.*.tsx`、`workflows.*.tsx`、`workspaces.$id.tsx`,以及本次重点的 `brain.tsx`/`health.tsx`/`insights.tsx`)完全没接入                                                                                                           | 自造字典覆盖率极低                                                                      |
| orchestrator 组件级统计                                                                                                                                                                                                                                                                                          | 全部 `app/components/v3/*.tsx`(约 25 个文件,承载工作流/运行可视化这一大块核心界面)、`app/components/board/*`、`app/components/skills/*` 均 **0 命中** `useTranslation`;全仓库只有 **9 个文件**(`root.tsx` 及上述 3 个路由 + `AccountUsageChip.tsx`/`Layout.tsx`/`Sidebar.tsx`/`DeployTab.tsx`/`ClaudeCodeCard.tsx`)真正用了这套自造字典                                                                                                                                                          | 即 9/123 个 app 文件接入                                                                |
| **反例(值得记录的正确实践)** `templates/orchestrator/app/routes/settings.tsx`(brain 运行时/引擎切换 UI 的载体)                                                                                                                                                                                                   | 全文搜索硬编码中文字符串 **0 处命中**                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 是全仓库少数完整走了 `t()` 字典的页面,证明这套自造机制『能用』,只是新页面没有被要求接入 |
| `templates/tracker/app/pages/SprintStudioPage.tsx` + 其 10 个 `components/studio/*.tsx` 子组件(`StepRail`/`BriefsStepView`/`StudioChatPanel`/`QualityGateBar`/`TestPlanScenarios`/`ProblemPoolDrawer`/`SignoffDialog`/`ArtifactToolRow`/`GenericArtifactContent` 等,即 Sprint 规划工作台/Sprint Studio 全部实现) | 中文字符命中合计 **115 处**(页面本身 12 处 + 10 个子组件 103 处)                                                                                                                                                                                                                                                                                                                                                                                                                                 | tracker 全仓库没有任何 i18n 机制,这些文案 100% 硬编码且无法切换语言                     |

---

## 3. 发现二:`packages/core/docs/content` 文档改动、locales 没跟上的地方

| 项                                 | 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 说明                                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 英文源 vs zh-CN 篇数差             | `packages/core/docs/content/` 下英文源文档共 **97 篇**(已用 glob 枚举核实),`locales/zh-CN/` 下只有 **84 篇**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 缺口对比后确认下列文档零翻译                                                                                                                                                                        |
| 全部 10 个语言目录零翻译的文档家族 | 以下文档在**全部 10 个语言目录**(ar-SA / de-DE / es-ES / fr-FR / hi-IN / ja-JP / ko-KR / pt-BR / zh-CN / zh-TW)里都**零翻译**(已逐个 glob 核实):`toolkit-agent-ux.mdx`、`toolkit-collaboration.mdx`、`toolkit-command-navigation.mdx`、`toolkit-comments-review.mdx`、`toolkit-history.mdx`、`toolkit-sharing.mdx`、`toolkit-setup-connections.mdx`、`toolkit-ui.mdx`、`toolkit-resources.mdx`、`toolkit-org-team.mdx`、`toolkit-settings.mdx`、`toolkit-observability.mdx`(完整的 `toolkit-*` 文档家族,**12 篇**,是 CLAUDE.md 里『Skill Index』明确点名的高频参考文档)、`generative-ui.mdx`、`doctor.mdx`、`automation-connectors.mdx` | 3 个文档家族(toolkit-\* / generative-ui / doctor / automation-connectors)在 10 语言全缺                                                                                                             |
| `durable-background-runs.mdx`      | CLAUDE.md 高优先级 slug 表中列出的关键文档,10 个语言目录里**仅 `zh-TW` 一个**有翻译,其余 9 个语言(含 `zh-CN`)缺失                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 单语言覆盖                                                                                                                                                                                          |
| fallback 行为                      | `internationalization.mdx` 自身第 104-116 行『Docs Site Content』小节写明:若某语言没有翻译该页,文档站会 fallback 到英文                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 以上缺口不会导致页面报错,但违反了 CLAUDE.md『改 `packages/core/docs/content` 下文档要同步更新 `locales/*`』的强制要求,且这些恰好是最近参考频率最高的一批文档(toolkit 系列、durable-background-runs) |
| 结构性原因                         | `scripts/guard-i18n-catalogs.ts` 的 `findCatalogDirs()`(第 297-311 行起)只扫描各模板 `app/i18n/` 目录来校验 catalog key parity/占位符/CLDR 复数,**完全不校验 `packages/core/docs/content/locales/*` 的文档翻译覆盖率**                                                                                                                                                                                                                                                                                                                                                                                                                  | 以上文档缺口不会被现有 guard 拦下,需要人工审查才能发现——这也是为什么这些缺口能长期存在而没有报错                                                                                                    |

---

## 4. 发现三:最近新加页面是否走了 i18n 机制

| 页面                                                                                      | 走机制与否 | 证据                                                                                                         |
| ----------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| Brain 控制台(`brain.tsx`,brain 运行时/大脑会话页)                                         | **否**     | 0 处 `useTranslation`,136 处硬编码中文,详见第 2 节                                                           |
| Brain 运行时切换(模型/引擎选择,实际落在 `settings.tsx` 的 Runtime/Models 标签页)          | **是**     | 0 处硬编码中文命中,完整走 `t()` 字典——是个正例,说明问题不是『机制不可用』,而是『新页面开发时没有被要求接入』 |
| 健康页(`health.tsx`,重设计)                                                               | **否**     | 0 处 `useTranslation`,77 处硬编码中文                                                                        |
| 洞察页(`insights.tsx`,重设计)                                                             | **否**     | 0 处 `useTranslation`,29 处硬编码中文,含数据常量数组里的硬编码 label                                         |
| Sprint 规划工作台 / Sprint Studio(tracker,`SprintStudioPage.tsx` + `components/studio/*`) | **否**     | 而且不只是『没接入』,是 tracker 应用**从未拥有过** i18n 机制,115 处硬编码中文                                |

---

## 5. 建议(简要)

1. **若产品决定 orchestrator/tracker 保持『中文优先』且不需要真正多语言**,应在两个模板的 CLAUDE.md
   里显式声明这是『受控偏离』(仿照顶层 CLAUDE.md 和 `docs/agent-native-alignment-audit.md` 的记录
   方式),避免继续被当作『待办』反复审查。

2. **若产品需要真正多语言**,orchestrator 应把 `lib/i18n.ts` 迁到框架标准的 `app/i18n/index.ts`
   catalog + `useT()`,让 `pnpm guard:i18n-catalogs` 能够覆盖它,并补齐 brain.tsx/health.tsx/
   insights.tsx 及 `components/v3/*` 的接入;tracker 需要从零建立框架 i18n 机制。

3. **`scripts/guard-i18n-catalogs.ts` 建议增加一个轻量检查**:统计 `templates/*/app/**/*.tsx` 中
   直接出现的 CJK 字符串占比,对已接入 i18n 的模板做『新增硬编码中文』的漂移告警,避免这次这种
   『机制存在但新页面绕过』的情况再发生。

4. **`packages/core/docs/content` 的 CI/CD 或 PR 检查里**,建议对 `toolkit-*`、
   `durable-background-runs.mdx` 等已确认零翻译/单语言覆盖的文档补齐至少 `zh-CN` 版本,并考虑给
   `guard-i18n-catalogs.ts` 加一个『英文文档改动但对应 locale 文件更旧』的漂移检测。

---

> 方法:全部结论基于对 templates/orchestrator、templates/tracker、packages/core/docs/content、scripts/guard-i18n-catalogs.ts 的直接读码核实,file:line 与命中计数均为实测。日期 2026-07-19。
