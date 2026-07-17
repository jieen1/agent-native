import {
  IconChartDots,
  IconDatabaseOff,
  IconGitFork,
  IconHeartRateMonitor,
  IconInfoCircle,
  IconListSearch,
  IconScale,
  IconTopologyStar3,
} from "@tabler/icons-react";
import { Link } from "react-router";

import { EmptyState } from "@/components/board/EmptyState";
import { DataHint } from "@/components/health/health-shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `${APP_TITLE} — 洞察` }];
}

// S10 洞察页 (04-orchestrator.md §11). Every block below has NO backing action
// today — `insightsSummary` is only a planned action (04 §13), and the
// failure-attribution breakdown additionally needs `v3_runs.score` /
// `failureClass` columns that don't exist in the schema yet (also 04 §13).
// Rather than compute ad-hoc aggregates from `runsList` client-side (which
// would silently misrepresent "scorecard" semantics the design doc reserves
// for real failureClass data), every section below is a real, honest empty
// state. Do not fill these with fabricated numbers.

const KPI_ITEMS = [
  { label: "run 成功率" },
  { label: "中位 run 时长" },
  { label: "token / run" },
  { label: "schema 纠偏率" },
  { label: "评审平均轮数" },
];

export default function InsightsRoute() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-2 flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <IconChartDots className="size-4" />
        </span>
        <div>
          <h1 className="flex items-center gap-1.5 text-xl font-semibold tracking-tight sm:text-2xl">
            洞察
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="数据源说明"
                  className="text-muted-foreground/50 outline-none transition-colors hover:text-muted-foreground focus-visible:text-muted-foreground"
                >
                  <IconInfoCircle className="size-4" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-80 text-xs text-muted-foreground">
                本页每个区块都还没有真实数据源：`insightsSummary` 聚合 action
                尚未建立，失败归因还额外需要 `v3_runs.score` / `failureClass`
                列（均为 04 章 §13 列出的待建增量）。下面保留
                原型的结构，但不会用编造的数字或图表填充。
              </PopoverContent>
            </Popover>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            执行质量归因（scorecard 范式）—— run
            成功率、失败归因、模板质量、模型对比。
          </p>
        </div>
      </header>

      {/* ── KPI row ─────────────────────────────────────────────────────── */}
      <section className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {KPI_ITEMS.map((kpi) => (
          <Card key={kpi.label} className="py-3">
            <CardContent className="px-4 py-0">
              <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                {kpi.label}
              </div>
              <div className="mt-1 font-mono text-xl font-semibold text-muted-foreground/50">
                <DataHint trigger="—" variant="bare">
                  insightsSummary 聚合 action 尚未建立。
                </DataHint>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      {/* ── Failure attribution ────────────────────────────────────────── */}
      <section className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.2fr_1fr]">
        <Card className="py-3">
          <CardHeader className="gap-0 px-4 py-0">
            <CardTitle className="flex items-center gap-2 text-[13px] font-semibold">
              <IconGitFork className="size-4 text-muted-foreground" />
              失败归因
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 py-0 pt-2">
            <EmptyState
              icon={IconDatabaseOff}
              title="数据源建设中"
              description="按 prompt/tool/engine/template/harness 五层归因需要 v3_runs.failureClass 列，当前 schema 还没有这一列。"
              className="border-dashed py-8"
            />
          </CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="gap-0 px-4 py-0">
            <CardTitle className="flex items-center gap-2 text-[13px] font-semibold">
              <IconListSearch className="size-4 text-muted-foreground" />
              top 案例
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 py-0 pt-2">
            <EmptyState
              icon={IconDatabaseOff}
              title="数据源建设中"
              description="依赖同一份 failureClass 归因数据。"
              className="border-dashed py-8"
            />
          </CardContent>
        </Card>
      </section>

      {/* ── Template quality / model comparison ────────────────────────── */}
      <section className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.5fr_1fr]">
        <Card className="py-3">
          <CardHeader className="gap-0 px-4 py-0">
            <CardTitle className="flex items-center gap-2 text-[13px] font-semibold">
              <IconTopologyStar3 className="size-4 text-muted-foreground" />
              模板质量
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 py-0 pt-2">
            <EmptyState
              icon={IconDatabaseOff}
              title="数据源建设中"
              description="每模板的 runs / 成功率 / 超限率 / 平均重试需要 insightsSummary 聚合 action，尚未建立。"
              className="border-dashed py-8"
            />
          </CardContent>
        </Card>
        <Card className="py-3">
          <CardHeader className="gap-0 px-4 py-0">
            <CardTitle className="flex items-center gap-2 text-[13px] font-semibold">
              <IconScale className="size-4 text-muted-foreground" />
              模型对比 · 节点通过率
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 py-0 pt-2">
            <EmptyState
              icon={IconDatabaseOff}
              title="数据源建设中"
              description="vLLM vs sonnet 在 dev/reviewer 节点的通过率对比需要按 modelRealName 聚合 v3_spawns，尚未建立。"
              className="border-dashed py-8"
            />
          </CardContent>
        </Card>
      </section>

      <div className="mt-6 flex items-center gap-1.5 text-sm text-muted-foreground">
        <IconHeartRateMonitor className="size-4" />
        运行时与派发门的真实信号见{" "}
        <Link to="/health" className="underline-offset-2 hover:underline">
          健康
        </Link>
        。
      </div>
    </div>
  );
}
