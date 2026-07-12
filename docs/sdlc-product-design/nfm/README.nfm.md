<callout color="blue_bg">
	这是 SDLC 产品设计 v2.2 文档集的目录页。v2.2 是**产品级完整设计**：全部流程、全部页面 UI、Foundry 设计系统、11 屏高保真原型、**06 章 SDLC 资产复用与命名对照（权威）**，以及 **07 章自举实战根因聚类与修订（权威）**；只谈设计，不含工期与实施排期。流程域功能设计的前身（v1.1 两份文档）仍然有效，产品与交互冲突处以本文档集为准。
</callout>

## 文档索引

<table header-row="true">
<tr>
<td>章</td>
<td>文档</td>
<td>内容</td>
</tr>
<tr>
<td>00</td>
<td>总体设计：愿景、原则与系统全景</td>
<td>愿景、四条产品立场、十条设计原则、四应用架构、端到端旅程、人机分界、假设与前提、术语表</td>
</tr>
<tr>
<td>01</td>
<td>Foundry 设计系统</td>
<td>OKLCH tokens、字体、Tabler 图标、状态语汇（状态环、优先级信号条、动效）、业务组件规范、禁则</td>
</tr>
<tr>
<td>02</td>
<td>流程设计</td>
<td>八相位状态机、规划技能链、九套执行工作流族、工作流选择器、恢复与重试语义、Brain 可替换架构、回写通道</td>
</tr>
<tr>
<td>03</td>
<td>Tracker 流程域逐页设计</td>
<td>收件箱、看板、工作项、Sprint 驾驶舱、规划工作台、Epic 拆解与依赖图、队列、项目设置、度量，共 12 页</td>
</tr>
<tr>
<td>04</td>
<td>Orchestrator 执行域逐页设计</td>
<td>驾驶舱、运行 DAG 视图、工作流库与编辑器、Brain 控制台与引擎注册表、智能体、健康、洞察，共 13 页</td>
</tr>
<tr>
<td>05</td>
<td>UI 设计子流程与跨应用协作</td>
<td>ui-spec 技能、原型流水线、UI 评审门、design 与 content 的角色约定、A2A 全景、原型清单</td>
</tr>
<tr>
<td>06</td>
<td>SDLC 资产复用与命名对照（权威）</td>
<td>a-e 每个 skill、agent、脚本、模板的复用策略（逐字复用/结构移植/算法移植/系统替代）、docKey 与相位对照表、对拍验收口径</td>
</tr>
<tr>
<td>07</td>
<td>自举实战根因聚类与 v2.2 修订（权威）</td>
<td>SDLC-037~058 十个根因簇、设计盲区与实现欠账的区分、逐簇"不可能再发生/发生即可见"的机制对策索引</td>
</tr>
</table>

## 修订记录

<table header-row="true">
<tr>
<td>版本</td>
<td>内容</td>
</tr>
<tr>
<td>v2.0</td>
<td>初版完整设计；文档与 UI 各 3 轮独立评审</td>
</tr>
<tr>
<td>v2.1</td>
<td>Goal 锚定完成判据；auditing 显名 gap-analysis；P11 双表征与 P12 低摩擦原则；content 项目文档库模型；06 章 SDLC 资产复用对照与全文档命名对齐（technical-design、reviewer/gatekeeper 节点、sdlc-gap-analysis）；test-plan 富呈现改为覆盖矩阵加审查三问</td>
</tr>
<tr>
<td>v2.2</td>
<td>自举实战（B1–B3 派发实测加 M3-D/S0 质量调研）根因修订：新增 07 章十个根因簇；P13 机制优先于提示词与 A21–A23 新假设；02 章工作区契约、状态迁移守卫、R9 终态传导、执行器上下文契约、能力面矩阵、评审独立性、拆分契约；03 章收件箱评审请求、受守卫人工流转、观察问题池；04 章模型注册表、降级显式化、用量采集契约；06 章测试执行环境归属；原型 S4/S5 体现新控件</td>
</tr>
<tr>
<td>v2.2.1</td>
<td>Sprint S-v2.1 全量 issue 对照审查（07 章新增 5 节）：28 条目全复核、UNANSWERED 为零，补 5 处缺口——观测基线正确性 W4、迁移冒烟证据档、守卫表派发行、评审卡结构化核对清单、turn 终态判定契约、配置生效一致性告警</td>
</tr>
</table>

## 原型

高保真原型（11 屏）在 design 应用：《SDLC 产品设计 v2.2 · Foundry 原型》，入口屏 `index.html`，屏间以 `data-screen` 互链，设计系统为 **Foundry**。

## 阅读顺序建议

<table header-row="true">
<tr>
<td>你想做什么</td>
<td>建议路径</td>
</tr>
<tr>
<td>了解这套系统是什么、怎么用</td>
<td>00 到 02</td>
</tr>
<tr>
<td>评审交互与页面</td>
<td>01、03、04、05，对照 design 应用原型逐屏走查</td>
</tr>
<tr>
<td>对照 v1.1 的流程细节（验收纪律、红线、数据模型增量）</td>
<td>仓库 `docs/sdlc-system-design.md` 与 `docs/sdlc-implementation-plan.md`</td>
</tr>
</table>

## 源文件

仓库 `docs/sdlc-product-design/`：六章 markdown、`prototypes/` 11 屏 HTML、`nfm/` 本文档集的 NFM 发布版。
