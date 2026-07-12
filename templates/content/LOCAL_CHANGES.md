# 本地改动清单（相对 upstream agent-native）

> 目的：合并 upstream 时按本清单核对/重放，全部改动都刻意做成最小侵入。

## 1. 宽屏显示切换（2026-07-11）

现状编辑器把内容硬限制在 `max-w-3xl`（768px），宽屏下两侧留白过大。
新增右上角小按钮切换"标准/加宽"（加宽为 `min(76rem, 100% - 3rem)`），
偏好存 localStorage（`content-page-width`），对每个浏览器持久生效。

| 文件 | 改动 | upstream 冲突面 |
|---|---|---|
| `app/components/editor/PageWidthToggle.tsx` | **新文件**：按钮组件，切换 `<html data-page-wide>` | 无（新文件） |
| `app/components/editor/DocumentToolbar.tsx` | 1 行 import + 1 行 `<PageWidthToggle />`（插在 `<AgentToggleButton />` 前），均带 `LOCAL CUSTOMIZATION` 注释 | 极小；冲突时重放这两行即可 |
| `app/global.css` | 文件末尾追加一段带框线注释的覆盖规则（`html[data-page-wide] .w-full.max-w-3xl.mx-auto`） | 追加式，自动合并；若 upstream 改了编辑器容器类名（当前为 `DocumentEditor.tsx` 三处与 `DocumentDatabase.tsx` 一处的 `max-w-3xl`），同步更新此选择器 |
| `changelog/2026-07-11-wide-page-toggle.md` | 用户可见改动的 changelog 条目 | 无（新文件） |

设计取舍：不改 `DocumentEditor.tsx` / `DocumentDatabase.tsx` 的 class 字符串
（那是 upstream 高频改动面），宽度覆盖集中在 global.css 一处；按钮通过
`<html>` 属性广播，组件间零耦合。
