import { APP_TITLE } from "@/lib/app-config";
import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import { Badge } from "@/components/ui/badge";
import { IconBolt, IconRobot } from "@tabler/icons-react";

export function meta() {
  return [{ title: `${APP_TITLE} — V3 Agents` }];
}

const AGENT_TYPES = [
  { type: "agent", label: "Agent" },
  { type: "parallel_over", label: "Parallel" },
  { type: "loop", label: "Loop" },
  { type: "human_gate", label: "Human Gate" },
];

export default function V3AgentsRoute() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          V3 Agent Directory
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Registered agent types and node templates.
        </p>
      </header>

      <DataTable
        rows={AGENT_TYPES}
        rowKey={(r) => (r as any).type}
        columns={[
          {
            id: "type",
            header: "Type",
            cell: (r) => (
              <span className="font-medium text-sm">
                {(r as any).label}
              </span>
            ),
          },
          {
            id: "key",
            header: "Key",
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
            title="No agents registered"
            description="Agent types are defined in the DAG template."
            className="border-0"
            action={undefined}
          />
        }
      />

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
          Agent Configuration
        </h2>
        <div className="rounded-lg border bg-card p-6">
          <p className="text-sm text-muted-foreground">
            Agent models are resolved per-node at runtime. Template nodes may specify{" "}
            <code className="text-xs font-mono">model</code> or inherit from the run-level
            <code className="text-xs font-mono"> model_override</code>. Use the V3 Runs
            dashboard to inspect resolved models per execution.
          </p>
        </div>
      </section>
    </div>
  );
}
