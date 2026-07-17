import { useActionQuery } from "@agent-native/core/client";
import { IconChevronRight, IconHeartRateMonitor } from "@tabler/icons-react";
import { Link, useNavigate } from "react-router";

import { HealthDot } from "@/components/health/health-shared";
import { Button } from "@/components/ui/button";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: APP_TITLE }];
}

const NAV_ITEMS = [
  { to: "/runs", label: "运行" },
  { to: "/workflows", label: "工作流" },
  { to: "/agents", label: "智能体" },
  { to: "/workspaces", label: "工作区" },
  { to: "/spawns", label: "派生任务" },
  { to: "/pool", label: "资源池" },
];

const HEALTH_BAR_REFRESH_MS = 30_000;

interface RuntimeConfigRow {
  id: string;
  kind: "vllm" | "openai-compatible" | "claude-code";
  active: boolean;
}
interface RuntimeStatus {
  chatEngine: string | null;
  claudeCodeLoggedIn: boolean;
  claudeCodeExpired: boolean;
}
interface BrainQueueStatus {
  brainConcurrency: number;
  running: number;
}
interface HealthTelemetry {
  writebackFailed: number;
}

// Compact health bar (04-orchestrator.md §1): "健康条：vLLM ● · Claude Code ●
// · Brain 槽 2/2 · 调度器 ● [详情→/health]". Deep-links to /health for the
// full four-card + telemetry-trust breakdown; here it's just the dots so the
// dashboard answers "system healthy?" in one glance without duplicating
// /health's detail.
function HealthBar() {
  const { data: configs } = useActionQuery(
    "list-runtime-configs" as any,
    {},
    { refetchInterval: HEALTH_BAR_REFRESH_MS },
  ) as { data?: RuntimeConfigRow[] };
  const { data: runtime } = useActionQuery(
    "get-runtime-status" as any,
    {},
    { refetchInterval: HEALTH_BAR_REFRESH_MS },
  ) as { data?: RuntimeStatus };
  const { data: brain } = useActionQuery(
    "brain-queue-status" as any,
    {},
    { refetchInterval: HEALTH_BAR_REFRESH_MS },
  ) as { data?: BrainQueueStatus };
  const { data: telemetry } = useActionQuery(
    "health-telemetry" as any,
    {},
    { refetchInterval: HEALTH_BAR_REFRESH_MS },
  ) as { data?: HealthTelemetry };

  const vllmConfigured =
    !!configs?.some((c) => c.kind !== "claude-code" && c.active) ||
    runtime?.chatEngine === "ai-sdk:openai";
  const ccOk = !!runtime?.claudeCodeLoggedIn && !runtime?.claudeCodeExpired;
  const schedulerOk = telemetry ? telemetry.writebackFailed === 0 : undefined;

  return (
    <Link
      to="/health"
      className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border bg-card px-4 py-2.5 text-sm transition-colors hover:bg-muted/40"
    >
      <span className="flex items-center gap-1.5">
        <HealthDot tone={vllmConfigured ? "ok" : "off"} />
        vLLM
      </span>
      <span className="flex items-center gap-1.5">
        <HealthDot tone={!runtime ? "pending" : ccOk ? "ok" : "warn"} />
        Claude Code
      </span>
      <span className="flex items-center gap-1.5">
        Brain 槽{" "}
        <span className="font-mono text-muted-foreground">
          {brain?.running ?? 0}/{brain?.brainConcurrency ?? 0}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <HealthDot
          tone={
            schedulerOk === undefined ? "pending" : schedulerOk ? "ok" : "warn"
          }
        />
        调度器
      </span>
      <span className="ml-auto flex items-center gap-1 text-muted-foreground">
        <IconHeartRateMonitor className="size-3.5" />
        详情
        <IconChevronRight className="size-3.5" />
      </span>
    </Link>
  );
}

export default function V3HomeRoute() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            编排器
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            工作流执行、模板、智能体与工作区。
          </p>
        </div>
      </header>
      <HealthBar />
      <nav className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {NAV_ITEMS.map((item) => (
          <Button
            key={item.to}
            variant="outline"
            className="h-auto justify-start p-3"
            onClick={() => navigate(item.to)}
          >
            <span className="text-sm font-medium">{item.label}</span>
          </Button>
        ))}
      </nav>
    </div>
  );
}
