# Agent-Native 全应用中英双语（i18n）完整实施规划

> 目标：所有模板 app + 共享 core chrome 支持中文 / 英文运行时切换。
> 按本规划全部执行完成后，**用户能看到或 agent 会说出的每一处文本都已双语**，
> 且有自动机制证明"无遗漏"。
>
> 状态：**P0 spike 已通过**（见 §1）。本文件是 P0 之后的完整执行规划。

---

## 0. 核心约束（贯穿全程，不可违背）

1. **`packages/core` 源码零改动。** core 是上游，改它 = 永久合并地狱。所有 core
   文本的中文化由**构建期插件**在编译时完成，不碰 core 任何 `.ts/.tsx`。
2. **优先新增文件**（永不与上游冲突）；必须改的存量文件只限**模板自有**
   （`templates/*` 下的 `vite.config.ts`、`root.tsx`、`actions/`、`AGENTS.md`），
   每处改动尽量 1–3 行。
3. **运行时切换**，不是编译期定死一种语言。插件把硬编码英文**包成 `t()` 运行时
   查表调用**，由 locale 决定渲染哪种语言（P0 spike 用的是静态替换，仅验证"插件
   能摸到 core 源"；真实现是包 `t()`）。
4. **英文原文即 key。** 不手工编 key，降低维护与漂移成本。
5. **可证明的完整性。** 见 Part E —— 伪语言审计 + 守卫脚本，机器证明无遗漏。

---

## 1. P0 Spike 结论（已完成 ✅）

- `pnpm install` exit 0，core 构建通过，Windows 原生依赖无阻塞。
- 验证：monorepo dev 下模板把 `@agent-native/core/*` alias 到 `src` 源码；自写 Vite
  插件的 `transform` 钩子（`enforce: "pre"`）能拦截并改写 core 源里的硬编码英文。
- 证据：core 的 `TiptapComposer.tsx`、`AssistantChat.tsx` 经插件转译后，目标英文串
  在 Vite 产物中被替换为中文，原英文 0 残留。**core 源未改一字。**
- 产出（spike 文件，P2 起会被真实现取代或删除）：
  - `templates/chat/i18n-spike.plugin.ts`
  - `templates/chat/vite.config.ts`（+2 行）

---

## 2. 文本面全清单（"所有东西"的精确定义）

下表是本规划承诺覆盖的全部文本面。**"完成"= 下表所有"纳入"项在 zh/en 下均正确。**

| # | 文本面 | 位置 | 量级 | 机制 | 阶段 | 纳入 |
|---|---|---|---|---|---|---|
| 1 | core 共享 chrome（聊天壳/composer/设置面板） | `packages/core/src/client` | ~900–1000 | 构建期插件包 `t()` | P2–P3 | ✅ |
| 2 | 15 模板自有 UI（JSX/placeholder/aria/title/toast） | `templates/*/app` `*/components` | ~2500–3000 | 构建期插件包 `t()` | P4 | ✅ |
| 3 | Action 成功/摘要消息（`message`/`summary`） | `templates/*/actions` | ~649 | 插件包 `t()`（server env） | P5 | ✅ |
| 4 | Action 错误/throw 文案 | `templates/*/actions` | ~150 | 插件包 `t()` | P5 | ✅ |
| 5 | Onboarding 步骤文案 | `packages/core/src/onboarding/default-steps.ts` | ~5 步 | 插件（server env，请求 locale） | P6 | ✅ |
| 6 | 系统事务邮件（邀请/验证/改密） | `packages/core/src/server/email-templates.ts` | 3 封 | 插件 + 收件人 locale | P6 | ✅ |
| 7 | 通知渠道文案 | `packages/core/src/notifications/channels.ts` | 少量 | 插件 | P6 | ✅ |
| 8 | Agent 回复语言（让 agent 用中文答） | 模板 `AGENTS.md` + 运行时 locale | 指令 | 模板自有指令注入 | P7 | ✅ |
| 9 | 日期/数字/货币格式 | 54 处 `en-US` + analytics `$` | 中 | locale-aware 格式化工具 | P8 | ✅ |
| 10 | `<html lang>` | 15 × `templates/*/app/root.tsx` | 15 | 模板 root 读 cookie | P1/P6 | ✅ |
| 11 | shadcn 原语 `sr-only`（Close/More 等） | `templates/*/components/ui` | ~10/模板 | 插件包 `t()` | P4 | ✅ |
| — | **以下明确不纳入（见 §3 理由）** | | | | | |
| 12 | Skill 文档 `SKILL.md` | `.agents/skills`、`templates/*/.agents` | 329 | — | — | ❌ |
| 13 | Action 的 `description:` 工具说明 | `templates/*/actions` | 153 | — | — | ❌ |
| 14 | Zod `.describe()` 参数说明 | `templates/*/actions` | 1963 | — | — | ❌ |
| 15 | 系统提示英文正文 | `core/src/server/prompts/*` | ~500 行 | — | — | ❌ |

---

## 3. 范围边界说明（为什么 12–15 不纳入）

12–15 全是**给模型读的指令文本**，不是用户能看到的 UI，也不是 agent 的输出：

- 翻译它们**不改变任何用户可见结果**，却有真实**回归风险**（模型对中文指令的遵循度、
  工具调用稳定性可能下降）。
- "让 agent 说中文"这一用户可感知目标，由 **P7 的回复语言指令**达成 —— agent 读英文
  指令、用中文作答，是 LLM 的常规能力，无需翻译指令本身。
- 因此本规划对"所有东西翻译完成"的定义 = **用户可见 + agent 输出**全双语；
  内部模型指令保持英文是**有意设计**，非遗漏。

> 若你要求连 12–15 也译，单列为 **P11（可选附加）**，预计工作量翻倍且需回归评测，
> 默认不执行。

---

## 4. 架构总览

```
                         ┌─────────────────────────────────────────┐
                         │  新增包 packages/locale-kit (全部新增,    │
                         │  不碰 core, 不与上游冲突)                 │
                         ├─────────────────────────────────────────┤
  切换源                 │ • runtime: t(), I18nProvider, useLocale   │
  ┌──────────────┐  写   │ • catalogs: en.json / zh.json (+ pseudo)  │
  │ UI 语言下拉   │─────► │ • formatDate/Number/Currency (Intl)       │
  │ change-language│ app  │ • vite 插件: AST 包 t() + 抽取 en key     │
  │  action(agent)│ state │ • extract CLI + translate 流水线          │
  └──────────────┘       │ • guard: 完整性守卫 + 伪语言审计          │
         │               └───────────────┬───────────────────────────┘
         ▼ application_state.locale       │ 注入/被 import
   + u:<email>:locale (持久)              ▼
   + Cookie: locale (SSR 首屏)    ┌────────────────────────────┐
         │ 轮询(core 现成通道)   │ 每个 template (自有, 小改):  │
         ▼                       │ • vite.config +plugin        │
   useLocaleSync()               │ • root.tsx 读 cookie→lang/初值│
   → i18n.changeLanguage         │ • actions/change-language.ts │
   → document.lang               │ • AGENTS.md +回复语言指令     │
                                 └────────────────────────────┘
```

**关键点**：插件在编译期把 core + 模板源里的硬编码英文**包成 `t("English source")`**
（不是替换成中文）；运行时 `t` 按当前 locale 查 catalog。core 源永不改 —— 改的是
"Vite 喂给浏览器/服务端的编译产物"。

### 4.1 新增包 `packages/locale-kit`（命名避开上游可能占用）

导出：

- `locale-kit`（runtime）：`t`, `tx`(插值), `I18nProvider`, `useLocale`, `setLocale`
- `locale-kit/vite`：`localeKitPlugin({ include, catalogDir })`
- `locale-kit/format`：`formatDate`, `formatNumber`, `formatCurrency`（读当前 locale）
- `locale-kit/action`：`createChangeLanguageAction()`（模板注册即用）
- `locale-kit/cli`：`extract`（抽 key→en.json）、`audit`（完整性守卫）

> 新包是新增路径，`git pull` 上游永不冲突。

### 4.2 locale 状态（复刻 core 现成的 `appearance` 范式）

- **session 级**：`application_state.locale` —— agent 可写（满足"UI 能做 agent 也能做"），
  走 core **已有**的 `/_agent-native/application-state/*` 路由，**不改 core**。
- **持久级**：`u:<email>:locale` —— 跨设备，走 core 现成 user-settings。
- **SSR 首屏**：`Cookie: locale` —— 模板 `root.tsx` 的 loader 读取，定 `<html lang>`
  与 provider 初值，消除水合闪烁。
- `change-language` action 写以上三处，`useLocaleSync()`（仿 `useAppearanceSync`）把
  服务端 locale 同步到 `i18n` + `document.documentElement.lang`。

### 4.3 插件包 `t()` 的规则（"完整但不过度"的核心）

AST 转换（用 `@babel/core` + 自定义 visitor，JSX/TS 成熟），**只包**：

- JSX 文本节点（`>Send<`）
- 属性白名单：`placeholder` `title` `aria-label` `aria-description` `alt` `label`
- `toast(...)` / `toast.error(...)` / `throw new Error(...)` / `AgentActionStopError`
  的**字符串字面量**实参
- action 返回对象的 `message` / `summary` 字段字符串

**不包**（避免误伤）：

- 非白名单属性、`className`、`id`、枚举/key、URL、`import`、`describe()`、`.spec` 文件
- 注释 `// i18n-ignore` 标记的行 / 节点
- 插值串 `` `Created ${id}` `` → 转为 `tx("Created {id}", { id })`（带占位的 ICU 形式）

---

## 5. 工作分块（Parts）

- **Part A — 运行时与状态**：`locale-kit` runtime、provider、locale 状态/同步/cookie、
  `change-language` action、语言下拉 UI。
- **Part B — 构建期插件**：AST 包 `t()`、自动抽取 en key、HMR、dev miss 收集。
- **Part C — 翻译生产**：en 抽取为 source of truth、术语表、agent 批量译 zh、人审。
- **Part D — 文本面覆盖**：core chrome → 15 模板 → action → server/邮件 → agent 回复
  → 格式化（即 §2 的 1–11）。
- **Part E — 完整性强制**：伪语言审计、未包裹检测守卫、缺译守卫、CI 接入、DoD。

---

## 6. 阶段路线图（Phases）与逐阶段验收

> 每阶段都有**可机器/可肉眼判定**的验收目标。未达标不进下一阶段。

### P0 — Spike（✅ 已完成）

- 验收：✅ 插件能改写 core 源串、core 零改、英文 0 残留。**已达成。**

---

### P1 — 运行时基座 + 状态 + 切换（Part A）

**做什么**

1. 建 `packages/locale-kit`，实现 `t`/`tx`/`I18nProvider`/`useLocale`/`setLocale`
   （此阶段 catalog 可手填几十条，验证机制）。
2. `useLocaleSync()`（仿 `packages/core/src/client/appearance.ts`）。
3. `createChangeLanguageAction()`：写 `application_state.locale` + `u:<email>:locale`
   + 下发 `Set-Cookie`。
4. chat 模板接入：`actions/change-language.ts` 注册；`root.tsx` 读 cookie 定 `<html lang>`
   + provider 初值；侧栏加语言下拉。
5. 手动把 chat 首页 **10 条**可见串包成 `t()` 做端到端样板。

**验收目标**

- [ ] chat 里点语言下拉 zh↔en，那 10 条串实时切换；刷新后保持。
- [ ] 对 agent 说"切成中文"→ agent 调 `change-language` → UI 同步变中文。
- [ ] `document.documentElement.lang` 随之变 `zh-CN`/`en`。
- [ ] 关浏览器重开 / 换设备登录，locale 保持（持久层生效）。
- [ ] `packages/core` 仍 0 改动（`git diff packages/core` 为空）。

---

### P2 — 构建期插件：自动包 `t()` + 抽 key（Part B）

**做什么**

1. 实现 `locale-kit/vite` 的 AST 插件（§4.3 规则），`enforce:"pre"`，
   `include` 默认 `packages/core/src/client/**` + `templates/<app>/app|components/**`。
2. 插件自动注入 `import { t, tx } from "locale-kit"`，把命中字面量改写为 `t()/tx()`。
3. 插件在构建中把所有命中 key 汇总写 `catalogs/en.json`（抽取 = source of truth）。
4. dev 下 `t()` 对缺 key 记录到 miss 收集端点 + 控制台。
5. chat 模板用插件替换 P1 的手工包裹（删 spike 文件）。

**验收目标**

- [ ] chat 的 core chrome + 自有 UI **全部**经插件自动包裹（不再有手工 `t()`）。
- [ ] `catalogs/en.json` 自动生成，含 chat 路径下全部命中 key，数量与源串量级吻合。
- [ ] 插值串正确转 `tx("... {x}", {x})`，渲染无 `{x}` 字面泄漏。
- [ ] 误包检查：`className`/URL/`describe()` 等**未**被包（抽样核 20 处）。
- [ ] `// i18n-ignore` 能豁免。
- [ ] core 仍 0 改动。

---

### P3 — chat 端到端双语（参考实现）（Part C 起步）

**做什么**

1. 建术语表（Draft/Thread/Event/Send… 固定中文译法）。
2. agent 批量把 chat 的 `en.json` 译成 `zh.json`，人审术语。
3. 接入 `formatDate/Number`（chat 内若有时间显示）。

**验收目标**

- [ ] chat 切 zh：聊天壳、composer、设置面板、侧栏、toast、空状态**全中文**，无英文残留。
- [ ] 切 en：全英文。
- [ ] 伪语言 `zz` 跑 chat：所有可见文字带标记（无裸 ASCII 文案）——首次完整性自检通过。
- [ ] `zh.json` 对 chat 的 `en.json` **键覆盖率 100%**（缺译守卫绿）。

---

### P4 — 铺开 15 个模板 UI（Part D 主体）

**做什么**

1. 每模板 `vite.config.ts` +1 行插件、`root.tsx` 读 cookie、注册 `change-language`
   （模板自有小改，可脚本化批量）。
2. 逐模板跑插件抽 `en.json` → agent 批译 `zh.json` → 人审。
3. 含 shadcn `sr-only` 串（#11）。
4. 建议顺序（按文本量）：先 chat(已完成) → dispatch/macros(轻) → mail/brain →
   forms/design/assets → slides/videos/plan → analytics/clips/content/calendar(重)。
   各模板独立，**可并行**（每模板一个子任务）。

**验收目标（对每个模板逐一判定）**

- [ ] 该模板切 zh/en，自有 UI + 继承的 core chrome 全双语。
- [ ] 该模板 `zh.json` 键覆盖率 100%。
- [ ] 伪语言审计该模板所有路由：0 裸 ASCII 用户文案。
- [ ] 该模板 `vite.config/root.tsx` 改动 ≤ 5 行；core 0 改动。
- [ ] **全部 15 模板**逐项打勾后 P4 才算完成。

---

### P5 — Action 消息与错误（#3 #4）（Part D）

**做什么**

1. 插件 `include` 扩到 `templates/*/actions/**`，包 `message`/`summary`/throw 字面量
   （server 环境也经 Vite/rollup 转换，dev SSR + prod build 均覆盖）。
2. `t()` 在服务端按**请求 locale**（cookie / app state）解析；无请求上下文的后台任务
   按**触发用户 locale**解析。
3. 批译这批 key。

**验收目标**

- [ ] 在 zh 下让 agent 执行操作（建草稿、发邮件、记一餐…），返回的成功/错误反馈为中文；
      en 下为英文。
- [ ] action `en.json`/`zh.json` 覆盖率 100%。
- [ ] 后台任务（如定时发送）产生的用户可见消息按目标用户 locale 输出。

---

### P6 — 服务端：Onboarding / 邮件 / 通知（#5 #6 #7 #10）（Part D）

**做什么**

1. 插件 `include` 覆盖 `core/src/onboarding/default-steps.ts`、
   `core/src/server/email-templates.ts`、`core/src/notifications/channels.ts`
   （仍 0 改源 —— 编译期包裹）。
2. 服务端请求级 `t`：用 AsyncLocalStorage 存请求 locale；邮件按**收件人** `u:<email>:locale`
   解析（邮件常由无请求的任务发出）。
3. 兜底：若某 server 模块未走 Vite 转换（极端情况），对该文件用 `pnpm patch` 单点补丁
   （仅此类才允许，且登记在案）。

**验收目标**

- [ ] onboarding 向导在 zh 下全中文。
- [ ] 邀请/验证/改密 3 封邮件：收件人 locale=zh 收到中文，=en 收到英文（含主题与正文）。
- [ ] 通知渠道文案双语。
- [ ] 若用到 `pnpm patch`：patch 文件数 ≤ 2 且文档记录；否则为 0。

---

### P7 — Agent 回复语言（#8）（Part D 体感关键）

**做什么**

1. 每模板 `AGENTS.md` 增一条指令："Always reply in the user's UI language given by
   `application_state.locale` (zh-CN ⇒ 简体中文; en ⇒ English)."（模板自有，不改 core）。
2. core 装配系统提示时会自动注入各 app 的 `AGENTS.md` —— 无需改 core。
3. 验证 agent 能读到 locale（必要时让 `change-language` 同时把 locale 写入 agent 可见的
   app state 字段）。

**验收目标**

- [ ] locale=zh 时，对 agent 提问，agent **用中文作答**；=en 用英文。
- [ ] 切换 locale 后新一轮对话语言随即改变。
- [ ] core 0 改动。

---

### P8 — 本地化格式（#9）（Part D）

**做什么**

1. `locale-kit/format` 包 `Intl.DateTimeFormat/NumberFormat`，读当前 locale。
2. 替换 54 处写死 `"en-US"`、analytics 手拼 `$` → `formatCurrency`、date-fns 传 locale。
   （这些多在模板自有代码；core 内的格式化由插件无法改逻辑——若涉及 core 日期工具，
   评估是否走 patch 或接受默认 locale 行为，登记。）

**验收目标**

- [ ] zh 下日期/数字/货币按中文区域格式呈现；en 下按英文。
- [ ] analytics 图表轴/金额随 locale 正确格式化。
- [ ] 抓 5 个高频格式点逐一核对。

---

### P9 — 完整性强制 + 总审计（Part E，"无遗漏"的硬保证）

**做什么 —— 三道机器闸**

1. **未包裹检测守卫** `locale-kit/cli audit --unwrapped`：AST 扫所有 in-scope 源，
   找出**应包未包**的用户可见字面量（JSX 文本 / 白名单属性 / toast / throw / message），
   列清单，**有则 CI 失败**。新代码若硬编码英文 → 立即报警。
2. **缺译守卫** `audit --missing`：每个 `en.json` 的 key 必须在 `zh.json` 有非空译文，
   否则失败。保证"抽出来的都译了"。
3. **伪语言 E2E 审计** `audit --pseudo`：locale=`zz` 把每个 `t()` 渲染成带标记文本，
   用 Playwright（已在 devDeps）遍历**全部 15 模板的全部路由** + 关键交互（打开 composer、
   发 toast、报错、邮件预览），截图 + DOM 扫描；**任何裸 ASCII 用户文案 = 遗漏**，输出坐标。

4. 三闸接入 `pnpm guards` 与 CI。

**验收目标（= 全局 Definition of Done 的机器部分）**

- [ ] `audit --unwrapped` = 0 违规（全仓 in-scope 源）。
- [ ] `audit --missing` = 0 缺译（全部 `en.json` ↔ `zh.json`）。
- [ ] `audit --pseudo` 遍历 15 模板全路由 = 0 裸 ASCII 用户文案。
- [ ] 三闸纳入 `pnpm guards`，CI 红/绿可阻断。

---

### P10 — 生产构建路径 + 终验（Part B/E 收尾）

**做什么**

1. 验证插件在 `agent-native build`（Nitro + rollup）产物里同样包裹生效（dist 路径）。
2. 全 15 模板 `pnpm build` 后用伪语言静态扫产物，确认包裹进入生产包。

**验收目标**

- [ ] 任一模板生产构建启动，切 zh/en 全双语（与 dev 一致）。
- [ ] 生产产物伪语言扫描 0 裸 ASCII 用户文案。

---

## 7. Definition of Done（总验收清单）

**全部勾选 = "所有东西翻译完成"：**

- [ ] §2 表中 **1–11 全部纳入项**在 zh 与 en 下均正确（含 core chrome、15 模板 UI、
      action 消息、onboarding、3 封邮件、通知、agent 回复、日期/货币、`<html lang>`、sr-only）。
- [ ] 语言切换：UI 下拉 **与** agent 指令两条路径都能全局切换，刷新 + 跨设备保持。
- [ ] **P9 三道闸全绿**：未包裹=0、缺译=0、伪语言裸文案=0（dev 与 prod 产物各一次）。
- [ ] `git diff packages/core` **为空**（core 零改）；存量文件改动仅限模板自有且每处 ≤5 行；
      如有 `pnpm patch` ≤2 个且登记。
- [ ] §3 的 12–15（模型指令）保持英文（有意设计，已声明）。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 插件误包/漏包 | 白名单 + `i18n-ignore` + P9 `--unwrapped` 守卫双向兜底 |
| 插值/复数 | 统一 `tx()` ICU，禁字符串拼接；守卫检测裸模板串 |
| SSR 水合闪烁 | cookie 驱动首屏 lang + provider 初值 |
| agent 改 app 又写死英文 | 更新 `frontend-design`/`self-modifying-code` skill 教用 `t()`；`--unwrapped` 守卫拦截 |
| server 串够不到 Vite 转换 | 优先插件；极端情况 `pnpm patch` 单点（登记，≤2） |
| 生产 build 与 dev 行为偏差 | P10 专门对产物做伪语言扫描 |
| 术语不一致 | 先锁术语表再批译 |
| 上游更新 core 新增英文串 | 拉取后重跑 `extract` + `--unwrapped`；新串入 catalog，core 仍不改 |

---

## 8.5 P3 产出 —— 插件已具备的包裹能力（P4/P9 参照）

`locale-kit` 的构建期插件（`packages/locale-kit/src/vite/transform.ts`）经 P3 三轮增强，现已自动包裹以下**全部结构性类别**（零改 core，幂等，带 `// i18n-ignore` 豁免 + 防过包守卫）：

1. JSXText 文本节点
2. JSX 属性：白名单 [placeholder,title,aria-label,aria-description,alt,label] **+** 名称后缀匹配 `/(text|label|title|placeholder|tooltip|message|hint|caption|heading|cta|subtitle)$/`（如 `emptyStateText`、`composerPlaceholder`）
3. 属性里的字符串**数组**元素（如 `suggestions={[...]}`）
4. 对象属性值，键名 ∈ UI 文本集（title/label/description/text/hint/heading/tooltip/cta/placeholder/message/summary/prompt/question/…）
5. **三元/逻辑表达式分支**的字符串（仅限 JSX 子节点 / 可包裹属性 / toast·Error 实参位置）
6. `toast()` / `toast.{error,success,warning,info}` / `new Error()` / `new AgentActionStopError()` 首个字符串实参
7. **UI 命名的常量 / 默认参数值**：默认参数名 ∈ UI 文本集（`label = "Feedback"`）、或常量名匹配 UI 命名约定（`DEFAULT_SUBMIT_TEXT`、`successMessage`、`ERROR_COPY`）
8. 模板字面量 `` `...${x}` `` → `tx("... {x}", {x})`（ICU 插值）

**已知残留（不归插件，P9 处理 / 有意保留）：**
- `setError("…")` 等任意 setState 字符串实参（经变量间接渲染）—— setState 类调用非目标，P9 视情况手包。
- 字符串拼接 `"Connect " + name` —— 构建期无法定位，P9 处理。
- 应用名 / 组织名等**数据/专有名**（`Chat` 应用标题、`Personal` 组织名）—— 有意 passthrough。

**catalog 为共享单文件**：`packages/locale-kit/src/catalogs/{en,zh}.json`，英文原文即 key。同形词（同英文不同语境）极少，发现再按语境处理（P3 已修 `Plan`→规划）。

**P4 每模板接线 = 复刻 chat（4 处，均模板自有）**：`vite.config.ts` 加 `localeKitPlugin({include})`、`package.json` 加 `"locale-kit":"workspace:*"`、`app/root.tsx` 包 `I18nProvider`、`actions/change-language.ts` 注册 action。

## 9. 执行顺序与并行度

```
P1 → P2 → P3(chat 样板)
                 │
                 ├─ P4 (15 模板, 各自独立可并行)
                 ├─ P5 (actions)
                 │      └─ P6 (server/邮件) 依赖 P5 的 server t 基座
                 ├─ P7 (agent 回复, 独立)
                 └─ P8 (格式化, 独立)
                          ↓ 全部汇合
                        P9 (完整性闸) → P10 (生产终验) → DoD
```

- 串行关键链：P1→P2→P3（基座必须先稳）。
- P4 各模板、P7、P8 可在 P3 后并行推进。
- P9 必须在 P4–P8 全完成后运行（它审计全量）。
