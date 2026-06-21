# zh-CN Canonical Terminology Glossary (Agent-Native)

Authoritative reference for localizing the Agent-Native app UI from English to
Simplified Chinese (`en` → `zh-CN`). Every translator MUST use the one canonical
translation listed here for each term, every time. Consistency beats elegance.

Source of strings: `packages/locale-kit/src/catalogs/en.json` (1116 keys).

---

## 1. Canonical Term Table

Use the **zh-CN Canonical** column verbatim. Do not invent synonyms. When a term
appears inside a longer string, translate it with the canonical form unless a
note says otherwise.

| English | zh-CN Canonical | Notes |
|---|---|---|
| Agent | **Agent** (keep English) | RULING: keep "Agent" untranslated. It is the product's core brand concept (Agent Native, A2A, agent runs) and is widely recognized; 代理 collides with "proxy/agent-of-record" and 智能体 reads marketing-heavy and inflates UI width. |
| Agent Native | Agent Native | Product name. Do not translate. |
| Background Agent | 后台 Agent | |
| Chat | 对话 | RULING: use 对话 (not 聊天). 对话 is the neutral product-surface term; 聊天 sounds casual/social. |
| New chat | 新建对话 | Imperative button. |
| Thread | 会话线程 | A branched/forked conversation; distinct from 对话. Short label may use 线程. |
| Fork (chat/conversation) | 分叉 | "Fork this conversation" → 将此对话分叉。 |
| Message | 消息 | |
| Send | 发送 | Button: keep short. |
| Send message | 发送消息 | |
| Send to agent | 发送给 Agent | |
| Composer | 输入区 | The message composer; 输入框 acceptable for single-field contexts. |
| Prompt | 提示词 | The text/instruction input. "From Prompt" → 通过提示词。 |
| Draft | 草稿 | |
| Attachment | 附件 | |
| Action | 操作 | App operation exposed to agent + UI. Reserve 操作; do not use 动作. |
| Tool | 工具 | |
| Skill | 技能 | |
| Model | 模型 | |
| App Default Model | 应用默认模型 | |
| Provider | 提供方 | LLM/integration provider. |
| Engine | 引擎 | "Agent engine" → Agent 引擎。 |
| Run (noun) | 运行记录 | "Agent runs" → Agent 运行记录。 |
| Run (verb / button) | 运行 | "Run", "Run anyway" → 运行 / 仍要运行。 |
| Task | 任务 | |
| Schedule Task | 安排任务 | |
| Job | 作业 | Background unit of work; distinct from 任务. |
| Workspace | 工作区 | |
| Organization | 组织 | |
| Account | 账户 | |
| Settings | 设置 | "Go to Settings" → 前往设置。 |
| Observability | 可观测性 | |
| Context | 上下文 | "Context X-Ray" → 上下文透视。 |
| Memory | 记忆 | |
| Database | 数据库 | |
| Extension | 扩展 | "New Extension" → 新建扩展。 |
| Connect | 连接 | Button. "Connect Builder" → 连接 Builder。 |
| Connected | 已连接 | |
| Connecting… | 连接中… | Keep trailing ellipsis char `…`. |
| Sign in / Log in | 登录 | Both map to 登录. |
| Sign out | 退出登录 | |
| Approve | 批准 | "Approve to run" → 批准后运行。 |
| Reject | 拒绝 | |
| Retry | 重试 | |
| Restore | 恢复 | |
| Archive | 归档 | "Archive chat" → 归档对话。 |
| Pin | 置顶 | "Pin chat" → 置顶对话。 |
| Unpin | 取消置顶 | |
| Rename | 重命名 | "Rename chat" → 重命名对话。 |
| Delete | 删除 | |
| Remove | 移除 | Use 移除 (vs 删除) for detach/disassociate, e.g. "Remove domain" → 移除域名。 |
| Share | 共享 | |
| View | 查看 | |
| Edit | 编辑 | |
| Copy | 复制 | |
| Import | 导入 | "Import CSV" → 导入 CSV。 |
| Invite member | 邀请成员 | |
| Status | 状态 | |
| Usage | 用量 | |
| Details | 详情 | |
| History | 历史记录 | "Loading history" → 正在加载历史记录。 |
| Plan mode | 规划模式 | |
| Act mode | 执行模式 | |
| Chat mode | 对话模式 | |
| Agent mode | Agent 模式 | |
| Code mode | 代码模式 | |
| Coming soon | 即将推出 | |
| Loading… / Searching… | 正在加载… / 正在搜索… | Keep trailing `…` / `...` exactly as in source. |
| Failed / failed | 失败 | "Delete failed: {0}" → 删除失败：{0}。 |
| Required | 必填 / 必需 | Form field → 必填; capability → 必需 ("Agent engine required" → 需要 Agent 引擎). |

---

## 2. Passthrough List (keep EXACTLY as English, unchanged)

Never translate, transliterate, re-case, or add spaces inside these. Surrounding
prose is translated; the token itself stays byte-for-byte identical.

**Acronyms / tech tokens:**
`AI`, `MCP`, `A2A`, `CLI`, `HTTP`, `HTTPS`, `API`, `URL`, `SQL`, `OK`, `ID`,
`UI`, `JSON`, `CSV`, `CSS`, `HTML`, `SSE`, `DOM`, `SDK`, `LLM`, `JPEG`, `PNG`,
`GIF`, `WebP`

**Brands / proper nouns:**
`GitHub`, `Slack`, `Telegram`, `Google`, `Builder`, `Builder.io`, `Builder Cloud`,
`Builder Cloud Agents`, `Anthropic`, `OpenAI`, `Claude`, `Chrome`,
`Chrome DevTools`, `Zapier`, `Cloudflare`, `SendGrid`, `Mermaid`, `Drizzle`,
`Nitro`, `Alpine.js`

**Product proper nouns (keep English):**
`Agent Native`, `Agent`, `A2A`, `X-Ray` (within "Context X-Ray" → 上下文透视, but
the standalone proper noun stays English)

**Model names — never translate or alter version numbers:**
`Claude Haiku 4.5`, `Claude Sonnet 4.6`, `Sonnet 4.6`, `Opus`, `Haiku`, `Sonnet`,
and any `Claude *` / `Opus 4.x` / `Sonnet 4.x` / `Haiku 4.x` string.

**Identifiers, paths, code, and placeholders (keep as-is):**
- File paths and code: `src/routes/git.ts`, `gfmDoc`, `appAction`, `dbQuery`, etc.
- Secret/placeholder samples: `re_...`
- Single-symbol / punctuation-only / whitespace-only strings: `:`, `…`, `%`,
  `{0}`, etc. — leave unchanged.
- Any string that is ONLY a `{placeholder}`, a number, or punctuation.

---

## 3. Translation Rules

1. **Placeholders are inviolable.** Never translate, reorder the internals of, or
   add/remove characters inside `{...}` tokens. Keep `{0}`, `{1}`, `{name}`,
   `{label}`, `{pct}`, `{cause}`, `{message}`, `{command}`, `{MOD}`,
   `{triggerLabel}`, `{requestedScope}` exactly. You MAY move a whole placeholder
   to fit Chinese word order, but the token text stays identical.
   - `"Delete failed: {0}"` → `"删除失败：{0}"`
   - `"Action {name} failed: {cause}"` → `"操作 {name} 失败：{cause}"`
   - `"Context {pct}%, {0}. Open Context X-Ray."` → `"上下文 {pct}%，{0}。打开上下文透视。"`

2. **Preserve trailing punctuation and ellipsis exactly.** If the source ends in
   `…`, `...`, `.`, `:`, `?`, or a space, the translation must end the same way.
   Match the source's ellipsis style (`…` vs `...`) character-for-character.
   - `"Connecting…"` → `"连接中…"`
   - `"Searching..."` → `"正在搜索..."`

3. **Preserve leading/trailing spacing and newlines.** Some keys begin/end with a
   space or contain `\n` because they are concatenated fragments. Keep the same
   leading/trailing whitespace and the same `\n` positions; only translate the
   visible words.
   - `". Edit or remove it from the workspace."` → `"。请在工作区中编辑或移除它。"`
     (note the leading sentence-joining punctuation is preserved as a period).

4. **Punctuation localization.** Within translated prose use full-width Chinese
   punctuation: `，` `。` `：` `？` `！` `（）`. EXCEPTION: do not change
   punctuation that is part of a code token, placeholder, path, or passthrough
   string. A trailing ASCII `:` that is a label separator becomes `：`.

5. **Spacing around Latin/passthrough tokens.** Put one ASCII space between
   Chinese characters and adjacent Latin/number/passthrough tokens for
   readability: `连接 Builder`, `Agent 运行记录`, `导入 CSV`. Do not add spaces
   immediately inside punctuation or placeholders.

6. **UI tone: natural, concise software language (软件界面用语), not literal.**
   Translate meaning, not word-for-word. Avoid 翻译腔. Use established UI
   conventions (设置, 删除, 重试, 归档).

7. **Buttons / menu items: short and imperative.** Drop subjects and articles;
   use verb-first 2–4 character labels. `Run anyway` → `仍要运行`; `Sign out`
   → `退出登录`; `New chat` → `新建对话`. Do not append `。` to button labels.

8. **Consistency over context.** When a glossary term appears, use its canonical
   form even if a freer phrasing reads slightly smoother. Report any term you
   think genuinely needs a second translation back for a glossary update rather
   than diverging silently.

9. **Do not translate inside code blocks, file paths, env var names, or sample
   values.** Translate only surrounding human-readable prose.

10. **Leave a string untranslated if it is purely passthrough** (acronym, brand,
    path, placeholder, or symbol). Returning it unchanged is correct, not a miss.
