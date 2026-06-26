import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconBrandOpenai,
  IconCheck,
  IconCircleCheck,
  IconKey,
  IconPhoto,
  IconPlayerPlay,
  IconPlus,
  IconServer2,
  IconSparkles,
  IconStack2,
  IconTrash,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
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
  useTestRuntimeConfig,
} from "@/hooks/use-orchestrator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClaudeCodeCard } from "@/components/ClaudeCodeCard";

export function meta() {
  return [{ title: `${APP_TITLE} — 设置` }];
}

export default function SettingsRoute() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {t("settings.title")}
        </h1>
      </header>

      <Tabs defaultValue="claude">
        <TabsList className="mb-6">
          <TabsTrigger value="claude" className="gap-1.5">
            <IconSparkles className="size-4" />
            {t("settings.tabClaude")}
          </TabsTrigger>
          <TabsTrigger value="models" className="gap-1.5">
            <IconServer2 className="size-4" />
            {t("settings.tabModels")}
          </TabsTrigger>
          <TabsTrigger value="credentials" className="gap-1.5">
            <IconKey className="size-4" />
            {t("settings.tabCredentials")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="claude">
          <ClaudeCodeCard />
        </TabsContent>
        <TabsContent value="models">
          <ModelsTab />
        </TabsContent>
        <TabsContent value="credentials">
          <CredentialsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Section heading ──────────────────────────────────────────────────────────

function SectionHeading({
  icon,
  title,
}: {
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <h2 className="text-sm font-semibold">{title}</h2>
    </div>
  );
}

// ── Models & Engines: active status, vLLM endpoints, concurrency, images ─────

function ModelsTab() {
  const { t } = useTranslation();
  const { data: status } = useRuntimeStatus();
  const { data: runtimes = [] } = useRuntimeConfigs();
  const saveRuntime = useSaveRuntimeConfig();
  const activate = useActivateRuntime();
  const deleteRuntime = useDeleteRuntimeConfig();
  const testRuntime = useTestRuntimeConfig();

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:8000/v1");
  const [model, setModel] = useState("");
  const [models, setModels] = useState("");
  const [testResult, setTestResult] = useState<{
    id: string;
    output?: string | null;
    error?: string | null;
  } | null>(null);

  const vllmRuntimes = runtimes.filter((r) => r.kind !== "claude-code");

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
          toast.success(t("common.saved"));
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : t("common.actionFailed")),
      },
    );
  }

  function activateRuntime(id: string) {
    activate.mutate(
      { id },
      {
        onSuccess: () => toast.success(t("settings.active")),
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : t("common.actionFailed")),
      },
    );
  }

  function testVllm(id: string) {
    setTestResult(null);
    testRuntime.mutate(
      { id },
      {
        onSuccess: (res: unknown) => {
          const r = res as {
            output?: string | null;
            error?: string | null;
          } | null;
          if (r?.error) {
            setTestResult({ id, error: r.error });
            toast.error(r.error);
          } else if (r?.output) {
            setTestResult({ id, output: r.output });
            toast.success(t("settings.vllmTestResult"));
          } else {
            setTestResult({ id, error: t("common.actionFailed") });
          }
        },
        onError: (e: unknown) => {
          const msg = e instanceof Error ? e.message : t("common.actionFailed");
          setTestResult({ id, error: msg });
          toast.error(msg);
        },
      },
    );
  }

  return (
    <div className="space-y-8">
      {/* Active status */}
      <section>
        <div className="grid gap-2 rounded-lg border bg-card p-4 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">
              {t("settings.activeChat")}
            </p>
            <p className="truncate text-sm font-medium">
              {status?.chatEngine
                ? `${status.chatEngine}${status.chatModel ? ` · ${status.chatModel}` : ""}`
                : t("settings.none")}
            </p>
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
      </section>

      {/* vLLM / OpenAI-compatible endpoints */}
      <section>
        <SectionHeading
          icon={<IconBrandOpenai className="size-5" />}
          title={t("settings.vllmTitle")}
        />

        {vllmRuntimes.length > 0 ? (
          <ul className="mb-3 grid gap-2">
            {vllmRuntimes.map((r) => (
              <li key={r.id} className="rounded-lg border bg-card px-4 py-3">
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
                    <Badge className="gap-1 border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                      <IconCheck className="size-3" />
                      {t("settings.active")}
                    </Badge>
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
                    {t("settings.vllmTest")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => deleteRuntime.mutate({ id: r.id })}
                    aria-label={t("common.delete")}
                  >
                    <IconTrash className="size-4 text-muted-foreground" />
                  </Button>
                </div>
                {testResult && testResult.id === r.id ? (
                  <pre
                    className={`mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                      testResult.error
                        ? "border-destructive/30 bg-destructive/5 text-destructive"
                        : "border-emerald-500/30 bg-emerald-500/5 text-foreground/90"
                    }`}
                  >
                    {testResult.error ?? testResult.output}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-xs text-muted-foreground">
            {t("settings.vllmEmpty")}
          </p>
        )}

        <div className="grid gap-2 rounded-lg border border-dashed p-4">
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
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={addVllm}
              disabled={!name.trim() || !baseUrl.trim() || saveRuntime.isPending}
            >
              {saveRuntime.isPending ? (
                <Spinner className="size-4" />
              ) : (
                <IconPlus className="size-4" />
              )}
              {t("settings.vllmAdd")}
            </Button>
          </div>
        </div>
      </section>

      <ConcurrencySection />
      <ImagesSection />
    </div>
  );
}

// ── Concurrency: degree slider + microVM ceiling + live counts ───────────────

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
          toast.error(e instanceof Error ? e.message : t("common.actionFailed"));
        },
      },
    );
  }

  return (
    <section>
      <SectionHeading
        icon={<IconStack2 className="size-5" />}
        title={t("settings.concurrencyTitle")}
      />

      <div className="grid gap-5 rounded-lg border bg-card p-4">
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
        </div>

        <div className="flex items-center justify-between border-t pt-3">
          <Label className="text-sm text-muted-foreground">
            {t("settings.maxConcurrentVMs")}
          </Label>
          <span className="text-sm font-medium tabular-nums">{maxVMs}</span>
        </div>

        <div className="grid grid-cols-3 gap-3 border-t pt-3">
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

// ── Base microVM images (read-only) ──────────────────────────────────────────

function ImagesSection() {
  const { t } = useTranslation();
  const { data } = useRuntimeImages();
  const images = data?.images ?? [];

  return (
    <section>
      <SectionHeading
        icon={<IconPhoto className="size-5" />}
        title={t("settings.imagesTitle")}
      />

      {images.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.imagesEmpty")}
        </p>
      ) : (
        <ul className="grid gap-2">
          {images.map((img) => (
            <li key={img.ref} className="rounded-lg border bg-card px-4 py-3">
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
    </section>
  );
}

// ── Credentials (key presence only — never a value) ──────────────────────────

function CredentialsTab() {
  const { t } = useTranslation();
  const { data } = useRuntimeCredentials();
  const creds = data?.credentials ?? [];

  return (
    <section>
      <SectionHeading
        icon={<IconKey className="size-5" />}
        title={t("settings.credsTitle")}
      />

      {creds.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.credsEmpty")}
        </p>
      ) : (
        <ul className="grid gap-2">
          {creds.map((c) => (
            <li key={c.key} className="rounded-lg border bg-card px-4 py-3">
              <div className="flex items-center gap-2">
                <code className="truncate text-sm font-medium">{c.key}</code>
                <Badge
                  className={
                    c.present
                      ? "ml-auto gap-1 border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "ml-auto gap-1 border-transparent bg-muted text-muted-foreground"
                  }
                >
                  {c.present ? <IconCircleCheck className="size-3" /> : null}
                  {c.present
                    ? t("settings.credsRegistered")
                    : t("settings.credsMissing")}
                </Badge>
              </div>
              {c.mountedBy.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  <span className="text-xs text-muted-foreground">
                    {t("settings.credsMountedBy")}:
                  </span>
                  {c.mountedBy.map((m) => (
                    <Badge key={m} variant="outline" className="text-xs">
                      {m}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
