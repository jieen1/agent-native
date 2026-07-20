#!/usr/bin/env bash
# UI 设计一致性审查（工作项 l7eumji9by）— 静态证据扫描脚本（只读，不修改任何源码）。
#
# 用法: bash .design-audit/scripts/scan.sh          （在仓库根目录执行）
# 产出: stdout 上的 C1/C2/C4 证据清单，与
#       docs/sdlc-product-design/audits/2026-07-20-ui-consistency-audit.md 一一对应。
#
# 范围闭包（由路由 import 推导，见报告 §2）:
#   orchestrator: routes/{brain,health,insights,_index}.tsx
#                 + components/health/health-shared.tsx + components/board/{DataTable,EmptyState}.tsx
#   tracker:      routes/_app.sprints.$id_.studio.tsx + pages/{SprintStudioPage,SprintsPage,SprintDetailPage}.tsx
#                 + components/studio/*.tsx + 页面直接引用的根级组件
#                 （ActorAvatar/ArtifactBadge/InspectorSection/PriorityBars/RunEvidenceList/
#                   SprintPhaseStepper/StatusIcon/StatusRing/tracker-format）

set -u
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

ORC="templates/orchestrator/app/routes/brain.tsx
templates/orchestrator/app/routes/health.tsx
templates/orchestrator/app/routes/insights.tsx
templates/orchestrator/app/routes/_index.tsx
templates/orchestrator/app/components/health/health-shared.tsx
templates/orchestrator/app/components/board/DataTable.tsx
templates/orchestrator/app/components/board/EmptyState.tsx"

TRK="templates/tracker/app/routes/_app.sprints.\$id_.studio.tsx
templates/tracker/app/pages/SprintStudioPage.tsx
templates/tracker/app/pages/SprintsPage.tsx
templates/tracker/app/pages/SprintDetailPage.tsx
templates/tracker/app/components/studio/ArtifactToolRow.tsx
templates/tracker/app/components/studio/BriefsStepView.tsx
templates/tracker/app/components/studio/GenericArtifactContent.tsx
templates/tracker/app/components/studio/ProblemPoolDrawer.tsx
templates/tracker/app/components/studio/QualityGateBar.tsx
templates/tracker/app/components/studio/SignoffDialog.tsx
templates/tracker/app/components/studio/StepRail.tsx
templates/tracker/app/components/studio/StudioChatPanel.tsx
templates/tracker/app/components/studio/TestPlanScenarios.tsx
templates/tracker/app/components/ActorAvatar.tsx
templates/tracker/app/components/ArtifactBadge.tsx
templates/tracker/app/components/InspectorSection.tsx
templates/tracker/app/components/PriorityBars.tsx
templates/tracker/app/components/RunEvidenceList.tsx
templates/tracker/app/components/SprintPhaseStepper.tsx
templates/tracker/app/components/StatusIcon.tsx
templates/tracker/app/components/StatusRing.tsx
templates/tracker/app/components/tracker-format.ts"

FILES="$ORC
$TRK"

echo "════ C1-a 裸色值字面量（#hex / rgb( / hsl(）════"
# shellcheck disable=SC2086
grep -nE "#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(" $FILES || echo "  （无命中）"

echo
echo "════ C1-b Tailwind 裸色类（palette-NNN / 任意值 [#…]）════"
# shellcheck disable=SC2086
grep -nE "(bg|text|border|ring|fill|stroke|from|to|via|shadow|outline|accent|divide|decoration)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)-[0-9]|(bg|text|border|ring|fill|stroke)-\[#|(bg|text|border|ring)-\[rgb|(bg|text|border)-\[hsl" $FILES | sort

echo
echo "════ C2 左侧竖条（border-left / borderLeft / border-l-）════"
# shellcheck disable=SC2086
grep -nE "border-left|borderLeft|border-l-|border-l\b" $FILES || echo "  （无命中）"

echo
echo "════ C3 次级面板表面底色（bg-muted* / bg-card / bg-background 的容器级用法）════"
# shellcheck disable=SC2086
grep -nE "<aside|bg-muted/[0-9]+\"|bg-muted/40|bg-muted/20|bg-muted/10" $FILES

echo
echo "════ C4 路A：--panel 是否在任一落地 CSS 中定义（预期：无命中=缺口）════"
grep -rn -- "--panel" templates/orchestrator/app templates/tracker/app \
  --include="*.css" --include="*.tsx" --include="*.ts" || echo "  （无命中 → 应用未落地 --panel token）"

echo
echo "════ C4 路A：dark 主题 token 覆写块（global.css .dark）════"
grep -n "^\.dark" templates/orchestrator/app/global.css templates/tracker/app/global.css

echo
echo "════ C4 路A：写死且缺 dark: 变体的深色文字（深色下对比度失效）════"
# shellcheck disable=SC2086
grep -nE "text-(red|amber|emerald|blue|purple|pink|indigo|teal|rose|slate|violet|sky|yellow|green)-[67]00" $FILES | grep -v "dark:" || echo "  （无命中）"
