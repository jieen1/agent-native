import { useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  IconChevronDown,
  IconRefresh,
  IconClock,
  IconCalendarTime,
  IconCrown,
  IconLoader2,
  IconGauge,
} from "@tabler/icons-react";
import { useActionQuery, callAction } from "@agent-native/core/client";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Single GLOBAL account-usage indicator (left sidebar, bottom — beside the
// Capacity chip). It is the ONLY surface that reads the managed Claude account's
// subscription usage from Anthropic: account-level, shown once, NOT per brain
// session. The brain page no longer polls /oauth/usage.
//
// Fetch policy is owned by the `account-usage` action: SQL-persisted snapshot,
// served from cache for ~12 min. This component (a) mounts it on-demand, (b)
// refetches on a slow ~12-min background interval, and (c) offers a manual
// refresh that forces a fresh fetch (refresh:true) past the freshness window.
// With no credential the action makes zero network calls and reports
// connected:false — the expected state when the account is removed/suspended.

const REFRESH_MS = 12 * 60 * 1000;

type Severity = "normal" | "warning" | "critical";

interface UsageWindow {
  utilizationPct: number;
  resetsAt: string | null;
  severity: Severity;
}

interface AccountUsage {
  available: boolean;
  connected: boolean;
  reason: string | null;
  fetchedAt: string | null;
  cached: boolean;
  stale: boolean;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  planTier: string | null;
  plan: string | null;
}

function severityBar(sev: Severity): string {
  if (sev === "critical") return "bg-red-500";
  if (sev === "warning") return "bg-amber-500";
  return "bg-emerald-500";
}

/** "2h 14m" from an ISO timestamp; "" when null, "现在" when past. */
function relativeReset(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "现在";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Short calendar date for the weekly reset (e.g. "7月1日"). */
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

/** Pretty plan tier: default_claude_max_20x → "Claude Max 20x". */
function prettyTier(tier: string | null, plan: string | null): string | null {
  if (!tier && !plan) return null;
  const raw = tier ?? plan ?? "";
  const m = raw.match(/max[_-]?(\d+x)/i);
  if (m) return `Claude Max ${m[1]}`;
  if (/pro/i.test(raw)) return "Claude Pro";
  if (/team/i.test(raw)) return "Claude Team";
  return (
    raw
      .replace(/^default[_-]/, "")
      .replace(/_/g, " ")
      .replace(/\bclaude\b/i, "Claude")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || raw
  );
}

function MiniBar({ pct, severity }: { pct: number; severity: Severity }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className={cn(
          "h-full rounded-full transition-all",
          severityBar(severity),
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function WindowRow({
  icon,
  label,
  window: w,
  resetText,
}: {
  icon: ReactNode;
  label: string;
  window: UsageWindow | null;
  resetText: string;
}) {
  const pct = w?.utilizationPct ?? null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="flex items-center gap-1 text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="font-medium tabular-nums">
          {pct != null ? `${Math.round(pct)}%` : "—"}
        </span>
      </div>
      <MiniBar pct={pct ?? 0} severity={w?.severity ?? "normal"} />
      {resetText ? (
        <span className="text-[10px] text-muted-foreground">{resetText}</span>
      ) : null}
    </div>
  );
}

export function AccountUsageChip() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const { data, refetch } = useActionQuery(
    "account-usage" as any,
    {},
    {
      // Slow background refresh (~12 min); never on window focus. The action's
      // SQL freshness window means this is the only periodic touch of Anthropic.
      refetchInterval: REFRESH_MS,
      refetchOnWindowFocus: false,
    },
  ) as { data?: AccountUsage; refetch: () => Promise<unknown> };

  async function handleRefresh(e: MouseEvent) {
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    try {
      // Force a fresh fetch past the freshness window (still token-guarded +
      // single-flight server-side), then re-read the persisted snapshot.
      await callAction(
        "account-usage" as any,
        { refresh: true },
        {
          method: "GET",
        },
      );
    } catch {
      // ignore — the refetch below still serves the last snapshot.
    }
    await refetch().catch(() => {});
    setRefreshing(false);
  }

  const tier = prettyTier(data?.planTier ?? null, data?.plan ?? null);
  const worst = Math.max(
    data?.fiveHour?.utilizationPct ?? 0,
    data?.weekly?.utilizationPct ?? 0,
  );
  const severities = [data?.fiveHour?.severity, data?.weekly?.severity];
  const worstSeverity: Severity = severities.includes("critical")
    ? "critical"
    : severities.includes("warning")
      ? "warning"
      : "normal";

  const connected = data?.connected === true;
  const available = data?.available === true;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-t border-sidebar-border px-2 py-1.5">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-md py-0.5 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("usage.account", { defaultValue: "账户用量" })}
          >
            <span className="flex items-center gap-1.5">
              <IconGauge className="size-3.5 shrink-0" />
              {t("usage.account", { defaultValue: "账户用量" })}
            </span>
            <span className="flex items-center gap-1.5">
              {!data ? (
                <span className="text-[10px]">
                  {t("usage.loading", { defaultValue: "加载中…" })}
                </span>
              ) : !connected ? (
                <span className="text-[10px] text-amber-600 dark:text-amber-500">
                  {t("usage.notConnected", { defaultValue: "未连接" })}
                </span>
              ) : available ? (
                <span className="font-medium tabular-nums text-sidebar-foreground">
                  {Math.round(worst)}%
                </span>
              ) : (
                <span className="text-[10px] text-amber-600 dark:text-amber-500">
                  {t("usage.unavailable", { defaultValue: "暂不可用" })}
                </span>
              )}
              <IconChevronDown
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  open && "rotate-180",
                )}
              />
            </span>
          </button>
        </CollapsibleTrigger>

        {/* Compact always-visible bar so the indicator reads at a glance. */}
        {connected && available ? (
          <div className="mt-1">
            <MiniBar pct={worst} severity={worstSeverity} />
          </div>
        ) : null}

        <CollapsibleContent>
          <div className="mt-2 flex flex-col gap-2.5 pb-0.5">
            {connected && available ? (
              <>
                <WindowRow
                  icon={<IconClock className="size-3.5 shrink-0" />}
                  label={t("usage.fiveHour", { defaultValue: "5 小时" })}
                  window={data?.fiveHour ?? null}
                  resetText={
                    data?.fiveHour?.resetsAt
                      ? `${relativeReset(data.fiveHour.resetsAt)} ${t("usage.resetsIn", { defaultValue: "后重置" })}`
                      : ""
                  }
                />
                <WindowRow
                  icon={<IconCalendarTime className="size-3.5 shrink-0" />}
                  label={t("usage.weekly", { defaultValue: "每周" })}
                  window={data?.weekly ?? null}
                  resetText={
                    data?.weekly?.resetsAt
                      ? `${shortDate(data.weekly.resetsAt)} ${t("usage.resetsAt", { defaultValue: "重置" })}`
                      : ""
                  }
                />
                {tier ? (
                  <div className="flex items-center gap-1.5">
                    <IconCrown className="size-3.5 shrink-0 text-amber-500" />
                    <Badge
                      variant="secondary"
                      className="h-5 px-1.5 text-[11px] font-medium"
                    >
                      {tier}
                    </Badge>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {data?.reason ??
                  t("usage.notConnected", { defaultValue: "未连接" })}
              </p>
            )}

            {/* As-of / stale + manual refresh */}
            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <span>
                {data?.fetchedAt
                  ? `${t("usage.asOf", { defaultValue: "截至" })} ${new Date(
                      data.fetchedAt,
                    ).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}${
                      data.stale
                        ? ` · ${t("usage.stale", { defaultValue: "已过期" })}`
                        : ""
                    }`
                  : ""}
              </span>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={refreshing}
                className="flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground disabled:opacity-50"
                aria-label={t("usage.refresh", { defaultValue: "刷新" })}
              >
                {refreshing ? (
                  <IconLoader2 className="size-3.5 animate-spin" />
                ) : (
                  <IconRefresh className="size-3.5" />
                )}
                {t("usage.refresh", { defaultValue: "刷新" })}
              </button>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
