import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconBrandOpenai,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { APP_TITLE } from "@/lib/app-config";
import {
  useActivateRuntime,
  useDeleteRuntimeConfig,
  useRuntimeConfigs,
  useRuntimeStatus,
  useSaveRuntimeConfig,
  useStartClaudeCode,
} from "@/hooks/use-orchestrator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function meta() {
  return [{ title: `${APP_TITLE} — Settings` }];
}

export default function SettingsRoute() {
  const { t } = useTranslation();
  const {
    data: status,
    refetch: refetchStatus,
    isFetching: statusFetching,
  } = useRuntimeStatus();
  const { data: runtimes = [] } = useRuntimeConfigs();
  const saveRuntime = useSaveRuntimeConfig();
  const activate = useActivateRuntime();
  const deleteRuntime = useDeleteRuntimeConfig();
  const startClaudeCode = useStartClaudeCode();

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:8000/v1");
  const [model, setModel] = useState("");
  const [ccResult, setCcResult] = useState<{
    output?: string | null;
    error?: string | null;
  } | null>(null);

  const vllmRuntimes = runtimes.filter((r) => r.kind !== "claude-code");
  const ccInstalled = !!status?.claudeCodeInstalled;
  const execIsClaudeCode = status?.executionRuntime === "claude-code";
  const ccLoggedIn = !!status?.claudeCodeLoggedIn;
  const ccExpired = !!status?.claudeCodeExpired;

  function addVllm() {
    if (!name.trim() || !baseUrl.trim()) return;
    saveRuntime.mutate(
      { name: name.trim(), kind: "vllm", baseUrl: baseUrl.trim(), model: model.trim() },
      {
        onSuccess: () => {
          setName("");
          setModel("");
          toast.success(t("common.save"));
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : "Failed"),
      },
    );
  }

  function activateRuntime(id: string) {
    activate.mutate(
      { id },
      {
        onSuccess: () => toast.success(t("settings.active")),
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : "Failed"),
      },
    );
  }

  function useClaudeCodeExecution() {
    // Create (idempotent-ish) a claude-code runtime row, then activate it.
    saveRuntime.mutate(
      { name: "Claude Code", kind: "claude-code" },
      {
        onSuccess: (res: unknown) => {
          const id = (res as { id?: string } | null)?.id;
          if (id) activateRuntime(id);
        },
      },
    );
  }

  function copyLoginCmd() {
    navigator.clipboard?.writeText("claude login").then(
      () => toast.success("claude login"),
      () => {},
    );
  }

  function testClaudeCode() {
    setCcResult(null);
    startClaudeCode.mutate(
      { prompt: "Reply with one short line: hello, and state your model." },
      {
        onSuccess: (res: unknown) => {
          const r = res as {
            ok?: boolean;
            output?: string | null;
            error?: string | null;
            timedOut?: boolean;
          } | null;
          if (r?.error) {
            setCcResult({ error: r.error });
            toast.error(r.error);
          } else if (r?.output) {
            setCcResult({ output: r.output });
            toast.success(t("settings.ccTestStarted"));
          } else if (r?.timedOut) {
            setCcResult({ error: "Timed out — no response from Claude Code." });
          } else {
            setCcResult({
              error:
                "Claude Code produced no output. Check `claude login` and CLAUDE_CODE_GIT_BASH_PATH.",
            });
          }
        },
        onError: (e: unknown) => {
          const msg = e instanceof Error ? e.message : "Failed";
          setCcResult({ error: msg });
          toast.error(msg);
        },
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {t("settings.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.subtitle")}
        </p>
      </header>

      {/* Current status */}
      <div className="mb-6 grid gap-2 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
        <div>
          <p className="text-xs text-muted-foreground">
            {t("settings.activeChat")}
          </p>
          <p className="text-sm font-medium">
            {status?.chatEngine
              ? `${status.chatEngine}${status.chatModel ? ` · ${status.chatModel}` : ""}`
              : t("settings.none")}
          </p>
          {status?.chatBaseUrl ? (
            <p className="truncate text-xs text-muted-foreground">
              {status.chatBaseUrl}
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">
            {t("settings.activeExec")}
          </p>
          <p className="text-sm font-medium">{status?.executionRuntime ?? "local"}</p>
        </div>
      </div>

      {/* vLLM / OpenAI-compatible */}
      <section className="mb-8">
        <div className="mb-1 flex items-center gap-2">
          <IconBrandOpenai className="size-5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("settings.vllmTitle")}</h2>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {t("settings.vllmSubtitle")}
        </p>

        {vllmRuntimes.length > 0 ? (
          <ul className="mb-3 grid gap-2">
            {vllmRuntimes.map((r) => (
              <li
                key={r.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {r.baseUrl}
                    {r.model ? ` · ${r.model}` : ""}
                  </p>
                </div>
                {r.active ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <IconCheck className="size-3" />
                    {t("settings.active")}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => activateRuntime(r.id)}
                  >
                    {t("settings.activate")}
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => deleteRuntime.mutate({ id: r.id })}
                >
                  <IconTrash className="size-4 text-muted-foreground" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-xs text-muted-foreground">
            {t("settings.vllmEmpty")}
          </p>
        )}

        <div className="grid gap-2 rounded-lg border border-dashed border-border p-4">
          <div className="grid gap-2 sm:grid-cols-3">
            <Input
              placeholder={t("settings.vllmName")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              placeholder={t("settings.vllmModel")}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <Input
              placeholder={t("settings.vllmBaseUrl")}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={addVllm}
              disabled={!name.trim() || !baseUrl.trim() || saveRuntime.isPending}
            >
              <IconPlus className="size-4" />
              {t("settings.vllmAdd")}
            </Button>
          </div>
        </div>
      </section>

      {/* Claude Code */}
      <section>
        <div className="mb-1 flex items-center gap-2">
          <IconSparkles className="size-5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("settings.ccTitle")}</h2>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {t("settings.ccSubtitle")}
        </p>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {/* Header: install state + login badge */}
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <span
                className={`size-1.5 rounded-full ${ccInstalled ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
              />
              <span className="font-medium">
                {ccInstalled
                  ? t("settings.ccInstalled")
                  : t("settings.ccNotInstalled")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {execIsClaudeCode ? (
                <Badge className="gap-1 border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  <IconCheck className="size-3" />
                  {t("settings.active")}
                </Badge>
              ) : null}
              <Badge
                className={
                  ccLoggedIn
                    ? "gap-1 border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : ccExpired
                      ? "gap-1 border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      : "gap-1 border-transparent bg-red-500/15 text-red-600 dark:text-red-400"
                }
              >
                {ccLoggedIn ? (
                  <IconCircleCheck className="size-3" />
                ) : (
                  <IconAlertTriangle className="size-3" />
                )}
                {ccLoggedIn
                  ? `${t("settings.ccLoggedIn")}${status?.claudeCodeSubscription ? ` · ${status.claudeCodeSubscription}` : ""}`
                  : ccExpired
                    ? t("settings.ccExpired")
                    : t("settings.ccNotLoggedIn")}
              </Badge>
            </div>
          </div>

          <div className="space-y-4 p-4">
            {/* Install hint */}
            {!ccInstalled ? (
              <Alert>
                <IconAlertTriangle className="size-4" />
                <AlertDescription className="font-mono text-xs">
                  {t("settings.ccInstallHint")}
                </AlertDescription>
              </Alert>
            ) : null}

            {/* Login: confirmation when good, a proper notice when not */}
            {ccLoggedIn ? (
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <IconCircleCheck className="size-4 shrink-0" />
                <span>
                  {t("settings.ccLoggedIn")}
                  {status?.claudeCodeSubscription
                    ? ` · ${status.claudeCodeSubscription}`
                    : ""}
                  {status?.claudeCodeExpiresAt
                    ? ` · ${t("settings.ccLoginValidUntil")} ${new Date(status.claudeCodeExpiresAt).toLocaleDateString()}`
                    : ""}
                </span>
              </div>
            ) : (
              <Alert className="border-amber-500/40 bg-amber-500/10 [&>svg]:text-amber-500">
                <IconAlertTriangle className="size-4" />
                <AlertTitle className="text-amber-700 dark:text-amber-300">
                  {ccExpired
                    ? `${t("settings.ccExpired")}${status?.claudeCodeExpiresAt ? ` · ${new Date(status.claudeCodeExpiresAt).toLocaleDateString()}` : ""}`
                    : t("settings.ccNotLoggedIn")}
                </AlertTitle>
                <AlertDescription className="text-amber-700/90 dark:text-amber-300/90">
                  {t("settings.ccLoginHint")}
                  <div className="mt-2 flex items-center gap-2">
                    <code className="select-all rounded-md bg-amber-950/10 px-2 py-1 font-mono text-xs text-foreground dark:bg-amber-100/10">
                      claude login
                    </code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={copyLoginCmd}
                      aria-label="Copy"
                    >
                      <IconCopy className="size-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-7"
                      onClick={() => refetchStatus()}
                      disabled={statusFetching}
                    >
                      <IconRefresh
                        className={`size-3.5 ${statusFetching ? "animate-spin" : ""}`}
                      />
                      {t("common.confirm")}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={execIsClaudeCode ? "outline" : "default"}
                disabled={!ccInstalled || !ccLoggedIn || activate.isPending}
                onClick={useClaudeCodeExecution}
              >
                <IconSparkles className="size-4" />
                {t("settings.ccUse")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!ccInstalled || startClaudeCode.isPending}
                onClick={testClaudeCode}
              >
                <IconPlayerPlay className="size-4" />
                {startClaudeCode.isPending
                  ? t("settings.ccRunning")
                  : t("settings.ccTest")}
              </Button>
            </div>

            {/* Real test result */}
            {ccResult ? (
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {t("settings.ccResult")}
                </p>
                <pre
                  className={`max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                    ccResult.error
                      ? "border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400"
                      : "border-emerald-500/30 bg-emerald-500/5 text-foreground/90"
                  }`}
                >
                  {ccResult.error ?? ccResult.output}
                </pre>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
