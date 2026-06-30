import { APP_TITLE } from "@/lib/app-config";
import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import { Badge } from "@/components/ui/badge";
import { IconBolt, IconRobot } from "@tabler/icons-react";

export function meta() {
  return [{ title: `${APP_TITLE} — 智能体` }];
}

const AGENT_TYPES = [
  { type: "agent", label: "智能体" },
  { type: "parallel_over", label: "并行" },
  { type: "loop", label: "循环" },
  { type: "human_gate", label: "人工关卡" },
];

export default function V3AgentsRoute() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          智能体目录
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          已注册的智能体类型与节点模板。
        </p>
      </header>

      <DataTable
        rows={AGENT_TYPES}
        rowKey={(r) => (r as any).type}
        columns={[
          {
            id: "type",
            header: "类型",
            cell: (r) => (
              <span className="font-medium text-sm">
                {(r as any).label}
              </span>
            ),
          },
          {
            id: "key",
            header: "键",
            cell: (r) => (
              <Badge variant="secondary" className="font-mono text-xs">
                {(r as any).type}
              </Badge>
            ),
          },
        ]}
        empty={
          <EmptyState
            icon={IconRobot}
            title="暂无已注册的智能体"
            description="智能体类型在 DAG 模板中定义。"
            className="border-0"
            action={undefined}
          />
        }
      />

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
          智能体配置
        </h2>
        <div className="rounded-lg border bg-card p-6">
          <p className="text-sm text-muted-foreground">
            智能体模型在运行时按节点解析。模板节点可以指定{" "}
            <code className="text-xs font-mono">model</code>,或继承运行级的
            <code className="text-xs font-mono"> model_override</code>。使用「运行」
            仪表盘查看每次执行解析出的模型。
          </p>
        </div>
      </section>
    </div>
  );
}
