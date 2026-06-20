import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconAlertTriangle,
  IconBrandOpenai,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconKey,
  IconPhoto,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconServer2,
  IconSparkles,
  IconStack2,
  IconTrash,
} from "@tabler/icons-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { APP_TITLE } from "@/lib/app-config";
import {
  useActivateRuntime,
  useDeleteRuntimeConfig,
  useQueueStatus,
  useRuntimeConfigs,
  useRuntimeCredentials,
  useRuntimeImages,
  useRuntimeStatus,
  useSaveRuntimeConfig,
  useSetConcurrency,
  useStartClaudeCode,
  useTestRuntimeConfig,
} from "@/hooks/use-orchestrator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function meta() {
  return [{ title: `${APP_TITLE} — Settings` }];
}

export default function SettingsRoute() {
  const { t } = useTranslation();

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

      <Tabs defaultValue="runtime">
        <TabsList className="mb-6">
          <TabsTrigger value="runtime" className="gap-1.5">
            <IconServer2 className="size-4" />
            {t("settings.tabRuntime")}
          </TabsTrigger>
          <TabsTrigger value="images" className="gap-1.5">
            <IconPhoto className="size-4" />
            {t("settings.tabImages")}
          </TabsTrigger>
          <TabsTrigger value="credentials" className="gap-1.5">
            <IconKey className="size-4" />
            {t("settings.tabCredentials")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="runtime">
          <RuntimeTab />
        </TabsContent>
        <TabsContent value="images">
          <ImagesTab />
        </TabsContent>
        <TabsContent value="credentials">
          <CredentialsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Runtime tab: status, vLLM table + add form + Test, Claude Code, concurrency ─

function RuntimeTab() {
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
  const testRuntime = useTestRuntimeConfig();

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:8000/v1");
  const [model, setModel] = useState("");
  const [models, setModels] = useState("");
  const [ccResult, setCcResult] = useState<{
    output?: string | null;
    error?: string | null;
  } | null>(null);
  const [vllmResult, setVllmResult] = useState<{
    id: string;
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
    const extraModels = models
      .split(",")
      .map((m) => m.trim())
      .filter((m) => m !== "");
    saveRuntime.mutate(
      {
        name: name.trim(),
        kind: "vllm",
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(extraModels.length > 0 ? { models: extraModels } : {}),
      },
      {
        onSuccess: () => {
          setName("");
          setModel("");
          setModels("");
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

  function testVllm(id: string) {
    setVllmResult(null);
    testRuntime.mutate(
      { id },
      {
        onSuccess: (res: unknown) => {
          const r = res as {
            ok?: boolean;
            output?: string | null;
            error?: string | null;
          } | null;
          if (r?.error) {
            setVllmResult({ id, error: r.error });
            toast.error(r.error);
          } else if (r?.output) {
            setVllmResult({ id, output: r.output });
            toast.success(t("settings.vllmTestResult"));
          } else {
            setVllmResult({ id, error: "No response." });
          }
        },
        onError: (e: unknown) => {
          const msg = e instanceof Error ? e.message : "Failed";
          setVllmResult({ id, error: msg });
          toast.error(msg);
        },
      },
    );
  }

  function useClaudeCodeExecution() {
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
    <div>
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
          <p className="text-sm font-medium">
            {status?.executionRuntime ?? "local"}
          </p>
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
                className="rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.baseUrl}
                      {r.model ? ` · ${r.model}` : ""}
                      {r.models && r.models.length > 0
                        ? ` (+${r.models.length})`
                        : ""}
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
                    size="sm"
                    variant="outline"
                    disabled={testRuntime.isPending}
                    onClick={() => testVllm(r.id)}
                  >
                    <IconPlayerPlay className="size-4" />
                    {testRuntime.isPending && vllmResult?.id !== r.id
                      ? t("settings.vllmTesting")
                      : t("settings.vllmTest")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => deleteRuntime.mutate({ id: r.id })}
                  >
                    <IconTrash className="size-4 text-muted-foreground" />
                  </Button>
                </div>
                {vllmResult && vllmResult.id === r.id ? (
                  <div className="mt-2">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">
                      {t("settings.vllmTestResult")}
                    </p>
                    <pre
                      className={`max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                        vllmResult.error
                          ? "border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400"
                          : "border-emerald-500/30 bg-emerald-500/5 text-foreground/90"
                      }`}
                    >
                      {vllmResult.error ?? vllmResult.output}
                    </pre>
                  </div>
                ) : null}
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
          <Input
            placeholder={t("settings.vllmModels")}
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.vllmModelsHint")}
          </p>
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={addVllm}
              disabled={
                !name.trim() || !baseUrl.trim() || saveRuntime.isPending
              }
            >
              <IconPlus className="size-4" />
              {t("settings.vllmAdd")}
            </Button>
          </div>
        </div>
      </section>

      {/* Claude Code */}
      <section className="mb-8">
        <div className="mb-1 flex items-center gap-2">
          <IconSparkles className="size-5 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("settings.ccTitle")}</h2>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          {t("settings.ccSubtitle")}
        </p>

        <div className="overflow-hidden rounded-xl border border-border bg-card">
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
            {!ccInstalled ? (
              <Alert>
                <IconAlertTriangle className="size-4" />
                <AlertDescription className="font-mono text-xs">
                  {t("settings.ccInstallHint")}
                </AlertDescription>
              </Alert>
            ) : null}

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

      <ConcurrencySection />
    </div>
  );
}

// ── Concurrency: degree slider (writable) + VM ceiling (read-only) + live counts ─

function ConcurrencySection() {
  const { t } = useTranslation();
  const { data: queue, refetch } = useQueueStatus();
  const setConcurrency = useSetConcurrency();
  const [pending, setPending] = useState<number | null>(null);

  const degree = pending ?? queue?.concurrencyDegree ?? 3;
  const maxVMs = queue?.maxConcurrentVMs ?? 0;

  function commit(value: number) {
    setConcurrency.mutate(
      { degree: value },
      {
        onSuccess: () => {
          setPending(null);
          toast.success(t("settings.concurrencySaved"));
          refetch();
        },
        onError: (e: unknown) => {
          setPending(null);
          toast.error(e instanceof Error ? e.message : "Failed");
        },
      },
    );
  }

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <IconStack2 className="size-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">
          {t("settings.concurrencyTitle")}
        </h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("settings.concurrencySubtitle")}
      </p>

      <div className="grid gap-5 rounded-lg border border-border bg-card p-4">
        {/* Concurrency degree — writable slider */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <Label className="text-sm">{t("settings.concurrencyDegree")}</Label>
            <span className="text-sm font-medium tabular-nums">{degree}</span>
          </div>
          <Slider
            min={1}
            max={16}
            step={1}
            value={[degree]}
            onValueChange={(v) => setPending(v[0])}
            onValueCommit={(v) => commit(v[0])}
            disabled={setConcurrency.isPending}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("settings.concurrencyDegreeHint")}
          </p>
        </div>

        {/* maxConcurrentVMs — read-only ceiling */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <Label className="text-sm text-muted-foreground">
              {t("settings.maxConcurrentVMs")}
            </Label>
            <span className="text-sm font-medium tabular-nums">{maxVMs}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.maxConcurrentVMsHint")}
          </p>
        </div>

        {/* Live queue counts */}
        <div className="grid grid-cols-3 gap-3 border-t border-border pt-3">
          <Stat
            label={t("settings.concurrencyRunning")}
            value={queue?.running ?? 0}
          />
          <Stat
            label={t("settings.concurrencyQueued")}
            value={queue?.queued ?? 0}
          />
          <Stat
            label={t("settings.concurrencyVmsInUse")}
            value={queue?.vmsInUse ?? 0}
          />
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

// ── Images tab (read-only) ──────────────────────────────────────────────────

function ImagesTab() {
  const { t } = useTranslation();
  const { data } = useRuntimeImages();
  const images = data?.images ?? [];

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <IconPhoto className="size-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("settings.imagesTitle")}</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("settings.imagesSubtitle")}
      </p>

      {images.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.imagesEmpty")}
        </p>
      ) : (
        <ul className="grid gap-2">
          {images.map((img) => (
            <li
              key={img.ref}
              className="rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <code className="truncate text-sm font-medium">{img.ref}</code>
                {img.default ? (
                  <Badge variant="secondary" className="text-xs">
                    {t("settings.imagesDefault")}
                  </Badge>
                ) : null}
                <Badge
                  className={
                    img.status === "prebaked"
                      ? "ml-auto gap-1 border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "ml-auto gap-1 border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400"
                  }
                >
                  {img.status === "prebaked"
                    ? t("settings.imagesStatusPrebaked")
                    : t("settings.imagesStatusMissing")}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("settings.imagesRuntime")}: {img.runtime}
                {img.description ? ` — ${img.description}` : ""}
              </p>
              {img.tools.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {img.tools.map((tool) => (
                    <Badge key={tool} variant="outline" className="text-xs">
                      {tool}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {data?.note ? (
        <p className="mt-3 text-xs text-muted-foreground">{data.note}</p>
      ) : null}
    </section>
  );
}

// ── Credentials tab (key presence only — never a value) ─────────────────────

function CredentialsTab() {
  const { t } = useTranslation();
  const { data } = useRuntimeCredentials();
  const creds = data?.credentials ?? [];

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <IconKey className="size-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("settings.credsTitle")}</h2>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("settings.credsSubtitle")}
      </p>

      {creds.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.credsEmpty")}
        </p>
      ) : (
        <ul className="grid gap-2">
          {creds.map((c) => (
            <li
              key={c.key}
              className="rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <code className="truncate text-sm font-medium">{c.key}</code>
                <Badge
                  className={
                    c.present
                      ? "ml-auto gap-1 border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "ml-auto gap-1 border-transparent bg-muted text-muted-foreground"
                  }
                >
                  {c.present ? (
                    <IconCircleCheck className="size-3" />
                  ) : (
                    <IconAlertTriangle className="size-3" />
                  )}
                  {c.present
                    ? t("settings.credsRegistered")
                    : t("settings.credsMissing")}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {c.description}
              </p>
              {c.mountedBy.length > 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t("settings.credsMountedBy")}:{" "}
                  {c.mountedBy.map((m) => (
                    <Badge key={m} variant="outline" className="ml-1 text-xs">
                      {m}
                    </Badge>
                  ))}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {data?.note ? (
        <p className="mt-3 text-xs text-muted-foreground">{data.note}</p>
      ) : null}
    </section>
  );
}
