import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconBrandOpenai,
  IconCheck,
  IconCircleCheck,
  IconKey,
  IconLock,
  IconPhoto,
  IconPlayerPlay,
  IconPlus,
  IconRocket,
  IconServer2,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { ClaudeCodeCard } from "@/components/ClaudeCodeCard";
import { DeployTab } from "@/components/settings/DeployTab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useActivateRuntime,
  useDeleteRuntimeConfig,
  useRuntimeConfigs,
  useRuntimeCredentials,
  useRuntimeImages,
  useRuntimeStatus,
  useSaveRuntimeConfig,
  useTestRuntimeConfig,
} from "@/hooks/use-orchestrator";
import { APP_TITLE } from "@/lib/app-config";

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
          <TabsTrigger value="deploy" className="gap-1.5">
            <IconRocket className="size-4" />
            {t("settings.tabDeploy")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="claude">
          <div className="space-y-6">
            <ClaudeCodeCard />
            <BrainModelTierCard />
            <SpawnTimeoutCard />
            <BrainMonitorIntervalCard />
          </div>
        </TabsContent>
        <TabsContent value="models">
          <ModelsTab />
        </TabsContent>
        <TabsContent value="credentials">
          <CredentialsTab />
        </TabsContent>
        <TabsContent value="deploy">
          <DeployTab />
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

// ── Brain model tier (CC subscription restriction) ────────────────────────────

type BrainModelTierValue = "sonnet" | "all";

function BrainModelTierCard() {
  const { t } = useTranslation();
  const { data, refetch } = useActionQuery("get-brain-model-tier" as any, {});
  const setTier = useActionMutation("set-brain-model-tier" as any, {});

  const currentTier: BrainModelTierValue =
    (data as any)?.tier === "all" ? "all" : "sonnet";

  function handleChange(value: string) {
    setTier.mutate(
      { tier: value as BrainModelTierValue },
      {
        onSuccess: () => {
          toast.success(t("settings.ccTierSaved"));
          refetch();
        },
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          ),
      },
    );
  }

  return (
    <section>
      <SectionHeading
        icon={<IconLock className="size-5" />}
        title={t("settings.ccTierTitle")}
      />
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("settings.ccTierDesc")}
        </p>
        <Select
          value={currentTier}
          onValueChange={handleChange}
          disabled={setTier.isPending}
        >
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sonnet">{t("settings.ccTierSonnet")}</SelectItem>
            <SelectItem value="all">{t("settings.ccTierAll")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

// ── Spawn default timeout (ad-hoc investigation/patrol spawns) ──────────────

function SpawnTimeoutCard() {
  const { t } = useTranslation();
  const { data, refetch } = useActionQuery(
    "get-spawn-default-timeout" as any,
    {},
  );
  const setTimeout_ = useActionMutation("set-spawn-default-timeout" as any, {});

  const currentSeconds =
    typeof (data as any)?.seconds === "number" ? (data as any).seconds : 3600;
  const [draft, setDraft] = useState<string>("");
  const displaySeconds = draft !== "" ? draft : String(currentSeconds);

  function handleSave() {
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      toast.error(t("settings.spawnTimeoutInvalid"));
      return;
    }
    setTimeout_.mutate(
      { seconds: parsed },
      {
        onSuccess: () => {
          toast.success(t("settings.spawnTimeoutSaved"));
          setDraft("");
          refetch();
        },
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          ),
      },
    );
  }

  return (
    <section>
      <SectionHeading
        icon={<IconRocket className="size-5" />}
        title={t("settings.spawnTimeoutTitle")}
      />
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("settings.spawnTimeoutDesc")}
        </p>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            className="w-32"
            value={displaySeconds}
            onChange={(e) => setDraft(e.target.value)}
            disabled={setTimeout_.isPending}
          />
          <span className="text-xs text-muted-foreground">
            {t("settings.spawnTimeoutSeconds")}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSave}
            disabled={setTimeout_.isPending || draft === ""}
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ── Brain periodic drift-check interval (patrol cadence) ────────────────────

function BrainMonitorIntervalCard() {
  const { t } = useTranslation();
  const { data, refetch } = useActionQuery(
    "get-brain-monitor-default-interval" as any,
    {},
  );
  const setInterval_ = useActionMutation(
    "set-brain-monitor-default-interval" as any,
    {},
  );

  const currentSeconds =
    typeof (data as any)?.seconds === "number" ? (data as any).seconds : 120;
  const [draft, setDraft] = useState<string>("");
  const displaySeconds = draft !== "" ? draft : String(currentSeconds);

  function handleSave() {
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed < 0) {
      toast.error(t("settings.brainMonitorIntervalInvalid"));
      return;
    }
    setInterval_.mutate(
      { seconds: parsed },
      {
        onSuccess: () => {
          toast.success(t("settings.brainMonitorIntervalSaved"));
          setDraft("");
          refetch();
        },
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          ),
      },
    );
  }

  return (
    <section>
      <SectionHeading
        icon={<IconSparkles className="size-5" />}
        title={t("settings.brainMonitorIntervalTitle")}
      />
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("settings.brainMonitorIntervalDesc")}
        </p>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            className="w-32"
            value={displaySeconds}
            onChange={(e) => setDraft(e.target.value)}
            disabled={setInterval_.isPending}
          />
          <span className="text-xs text-muted-foreground">
            {t("settings.brainMonitorIntervalSeconds")}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={handleSave}
            disabled={setInterval_.isPending || draft === ""}
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </section>
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
  const [apiKey, setApiKey] = useState("");
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
    const trimmedApiKey = apiKey.trim();
    saveRuntime.mutate(
      {
        name: name.trim(),
        // A real API key means a remote OpenAI-compatible provider; no key
        // means the local vLLM/LM Studio case the UI has always covered.
        kind: trimmedApiKey ? "openai-compatible" : "vllm",
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        ...(extraModels.length > 0 ? { models: extraModels } : {}),
        ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
      },
      {
        onSuccess: () => {
          setName("");
          setModel("");
          setModels("");
          setApiKey("");
          toast.success(t("common.saved"));
        },
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          ),
      },
    );
  }

  function activateRuntime(id: string) {
    activate.mutate(
      { id },
      {
        onSuccess: () => toast.success(t("settings.active")),
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          ),
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
        <p className="mb-3 text-xs text-muted-foreground">
          {t("settings.vllmSubtitle")}
        </p>

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
            type="password"
            autoComplete="off"
            placeholder={t("settings.vllmApiKey")}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Input
            placeholder={t("settings.vllmModels")}
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={addVllm}
              disabled={
                !name.trim() || !baseUrl.trim() || saveRuntime.isPending
              }
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

      <ImagesSection />
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
