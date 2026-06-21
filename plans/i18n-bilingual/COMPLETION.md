# i18n 双语实施 — 完成记录

全 10 阶段(P0–P10)完成并逐阶段严格验收通过。`packages/core` 全程**零改动**。

## Definition of Done — 核对

- [x] **§2 文本面 1–11 全部双语**:core 共享 chrome、15 模板 UI、action 成功/错误消息、onboarding、3 封事务邮件、通知、agent 回复指令、日期/数字/货币格式、`<html lang>`、shadcn `sr-only`。
- [x] **语言切换双路径**:UI 语言下拉 + agent `change-language` action;持久(cookie + `u:<email>:locale`)、跨重载/设备保持。运行时实测 chat/content 切换 en↔zh 全中文、0 残留。
- [x] **P9 三道闸全绿(CI 接入 `pnpm guards` 的 `guard:i18n`)**:
  - `--missing` = 0(en 8753 / zh 8753,占位符 0 错配)
  - `--unwrapped` = 0 unsuppressed(2725 文件,1 候选 = Google Picker SDK,已 allowlist)
  - 伪语言 `zz`:chat 首页 + 侧栏 0 裸 UI 文本
- [x] **`packages/core` 零改**:`git diff` 与 `git status --porcelain` 均空(tracked + untracked)。
- [x] **生产构建验证**:chat + analytics `agent-native build` exit 0;zh catalog + `t()/tx()` 包裹 + P8 Intl 格式器进客户端 + SSR/Nitro 包;async_hooks 间接经 rollup+压缩存活。
- [x] **§3 模型指令保持英文(有意)**:zod `.describe()`(1963)、SKILL.md(329)、系统提示正文未包裹。仅 action 一行 `description:` 被译(低风险,偏完整性)。

## 架构(最终)

- **零改 core**:全部经新增包 `packages/locale-kit` + 构建期 Vite 插件(编译期把硬编码英文包成运行时 `t()/tx()`)+ 模板自有接线(`vite.config`/`root.tsx`/`actions/change-language.ts`/`AGENTS.md`)。
- **locale-kit**:`globalThis` 单例状态(current/catalogs/listeners/email映射/runWithLocale override ALS);`t/tx/useLocale/I18nProvider/useLocaleSync`;`locale-kit/vite`(AST 包裹+抽取插件)、`locale-kit/server`(`runWithLocale` 收件人/请求 locale)、`locale-kit/format`(Intl)、`locale-kit/action`(change-language)、`locale-kit/cli`(extract + audit)。
- **插件包裹类别**:JSXText、JSX 属性(白名单 + `*text|label|title|placeholder|...` 后缀)、字符串数组、对象 UI 文本属性(String + Template→tx)、三元/逻辑分支(限 JSX/属性/调用位置)、`toast/Error/AgentActionStopError` 实参、UI 命名常量/默认参数、UI 状态 setter 实参(`setError/setStatus/...`,仅自然语言)。
- **服务端 locale**:`resolveActiveLocale` = runWithLocale override → 请求用户 `u:<email>:locale` → 模块全局。
- **catalog**:共享 `packages/locale-kit/src/catalogs/{en,zh}.json`,英文原文即 key,8753 条,100% 覆盖。

## 已知边界(有意保留英文 / 需外部条件)

1. **Pre-auth 登录页营销**(`server/plugins/auth.ts` / core `auth-marketing.ts`):服务端渲染、无认证用户、core 不暴露 cookie 给 locale-kit → 首屏英文。串已抽取可译,locale 可解析后即中文。
2. **server-plugin 触发器描述**(如 `mail-jobs.ts` 的 automations 触发器说明):未纳入运行时包裹范围(避免广含 `server/plugins/` 误包 agent 系统提示)→ 英文。小众配置面。
3. **Agent 中文回复(P7)**:指令已注入 15 AGENTS.md + change-language 写 `application_state.locale` 已通;活体验证需模型凭据(本环境无)。
4. **邮件收件人 locale**:`runWithLocale` 原语已验证(`接受邀请` 等);实际发送需邮件 provider(本地未配)。
5. **全模板伪语言 Playwright 遍历**:机制就绪(`?locale=zz`);未对全 15 模板认证后路由穷举(Google OAuth 登录墙)。静态 `--unwrapped` 已覆盖全 2725 文件。

## 维护

- 新增英文 UI 串:插件自动包裹 + 抽取;`pnpm --filter locale-kit i18n:extract` 更新 en.json,补译 zh.json。
- CI 门禁:`pnpm run guard:i18n`(已入 `pnpm guards`)—— 缺译或应包未包则失败。
- 拉取上游后:重跑 extract + `guard:i18n` 收新串;core 仍不改。
</content>
