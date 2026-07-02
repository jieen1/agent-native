import { useCallback, useEffect, useRef, useState } from "react";
import { agentNativePath } from "./api-path.js";
import { callAction } from "./use-action.js";
import { DEFAULT_MODEL } from "../agent/default-model.js";
import {
  getReasoningEffortOptionsForModel,
  type ReasoningEffort,
} from "../shared/reasoning-effort.js";

export interface EngineModelGroup {
  engine: string;
  label: string;
  models: string[];
  configured: boolean;
}

export interface UseChatModelsResult {
  availableModels: EngineModelGroup[];
  defaultModel: string;
  selectedModel: string;
  selectedEngine: string;
  selectedEffort: ReasoningEffort;
  onModelChange: (model: string, engine: string) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  refreshEngines: () => void;
}

interface Options {
  /**
   * localStorage key used to persist the user's model + effort selection across
   * page loads. Pass `null` to disable persistence.
   */
  storageKey?: string | null;
  /**
   * Disable server-backed model discovery for hosts that provide their own
   * model list/state, such as Electron Code.
   */
  enabled?: boolean;
}

const DEFAULT_STORAGE_KEY = "agent-native:chat-models:selection";

interface PersistedSelection {
  model?: string;
  engine?: string;
  effort?: ReasoningEffort;
}

function readPersisted(key: string | null): PersistedSelection {
  if (!key || typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as PersistedSelection) : {};
  } catch {
    return {};
  }
}

function writePersisted(key: string | null, value: PersistedSelection) {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/**
 * Fetches available engines/models from the agent server and exposes the same
 * model picker state that `MultiTabAssistantChat` wires up — for surfaces like
 * the Dispatch homepage hero composer that need an identical model picker
 * without mounting the full tabbed chat.
 */
export function useChatModels({
  storageKey = DEFAULT_STORAGE_KEY,
  enabled = true,
}: Options = {}): UseChatModelsResult {
  const [availableModels, setAvailableModels] = useState<EngineModelGroup[]>(
    [],
  );
  const [defaultModel, setDefaultModel] = useState<string>(DEFAULT_MODEL);

  const initialPersisted = readPersisted(storageKey);
  const hasExplicitSelectionRef = useRef(Boolean(initialPersisted.model));
  const [selectedModel, setSelectedModel] = useState<string>(
    initialPersisted.model ?? DEFAULT_MODEL,
  );
  const [selectedEngine, setSelectedEngine] = useState<string>(
    initialPersisted.engine ?? "",
  );
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort>(
    initialPersisted.effort ?? "auto",
  );
  const selectionRef = useRef({
    selectedModel,
    selectedEngine,
    selectedEffort,
  });

  useEffect(() => {
    selectionRef.current = {
      selectedModel,
      selectedEngine,
      selectedEffort,
    };
  }, [selectedEffort, selectedEngine, selectedModel]);

  const onModelChange = useCallback(
    (model: string, engine: string) => {
      hasExplicitSelectionRef.current = true;
      const effortOptions = getReasoningEffortOptionsForModel(model);
      setSelectedModel(model);
      setSelectedEngine(engine);
      setSelectedEffort((prevEffort) => {
        const next =
          prevEffort === "auto" || effortOptions.includes(prevEffort)
            ? prevEffort
            : "auto";
        writePersisted(storageKey, { model, engine, effort: next });
        return next;
      });
    },
    [storageKey],
  );

  const onEffortChange = useCallback(
    (effort: ReasoningEffort) => {
      hasExplicitSelectionRef.current = true;
      setSelectedEffort(effort);
      writePersisted(storageKey, {
        model: selectedModel,
        engine: selectedEngine,
        effort,
      });
    },
    [selectedEngine, selectedModel, storageKey],
  );

  const refreshEngines = useCallback(() => {
    if (!enabled) return;
    Promise.all([
      callAction("manage-agent-engine" as any, { action: "list" } as any).catch(
        () => null,
      ),
      fetch(agentNativePath("/_agent-native/env-status"))
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => []),
      fetch(agentNativePath("/_agent-native/builder/status"))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([enginesData, envKeys, builderStatus]) => {
        if (!enginesData?.engines) return;
        const configuredKeys = new Set(
          (envKeys as Array<{ key: string; configured: boolean }>)
            .filter((k) => k.configured)
            .map((k) => k.key),
        );
        const builderConnected = builderStatus?.configured === true;
        const currentEngineName: string | undefined =
          enginesData.current?.engine;
        const currentModel: string | undefined = enginesData.current?.model;

        let groups: EngineModelGroup[];

        if (builderConnected) {
          const builderEngine = enginesData.engines.find(
            (e: any) => e.name === "builder",
          );
          const builderModels: string[] = builderEngine?.supportedModels ?? [];
          const claude = builderModels.filter((m: string) =>
            m.startsWith("claude-"),
          );
          const openai = builderModels.filter((m: string) =>
            m.startsWith("gpt-"),
          );
          const gemini = builderModels.filter((m: string) =>
            m.startsWith("gemini-"),
          );
          const other = builderModels.filter(
            (m: string) =>
              !m.startsWith("claude-") &&
              !m.startsWith("gpt-") &&
              !m.startsWith("gemini-"),
          );

          groups = [
            ...(claude.length
              ? [
                  {
                    engine: "builder",
                    label: "Claude",
                    models: claude,
                    configured: true,
                  },
                ]
              : []),
            ...(openai.length
              ? [
                  {
                    engine: "builder",
                    label: "OpenAI",
                    models: openai,
                    configured: true,
                  },
                ]
              : []),
            ...(gemini.length
              ? [
                  {
                    engine: "builder",
                    label: "Gemini",
                    models: gemini,
                    configured: true,
                  },
                ]
              : []),
            ...(other.length
              ? [
                  {
                    engine: "builder",
                    label: "More",
                    models: other,
                    configured: true,
                  },
                ]
              : []),
          ];
        } else {
          // NOTE (template integration / CORE-PATCHES.md): the model picker
          // allow-lists engines by name. A self-hosted template can register a
          // custom local engine (e.g. "vllm" → a local OpenAI-compatible vLLM)
          // via core's public registerAgentEngine; without it here the picker
          // would hide that engine and fall back to the built-ins, which can be
          // unusable in a bundled/workspace deploy (pkg-filtered or key-gated).
          const allowedEngines = new Set([
            "anthropic",
            "ai-sdk:openai",
            "ai-sdk:google",
            "vllm",
          ]);
          groups = enginesData.engines
            .filter(
              (e: any) =>
                allowedEngines.has(e.name) && e.packageInstalled !== false,
            )
            .map((e: any) => {
              const models = [...e.supportedModels];
              if (
                e.name === currentEngineName &&
                currentModel &&
                !models.includes(currentModel)
              ) {
                models.unshift(currentModel);
              }
              return {
                engine: e.name,
                label: e.label,
                models,
                configured:
                  e.requiredEnvVars.length === 0 ||
                  e.requiredEnvVars.some((v: string) =>
                    configuredKeys.has(v),
                  ) ||
                  e.name === currentEngineName,
              };
            });
        }
        const nextDefaultModel = currentModel ?? DEFAULT_MODEL;
        setAvailableModels(groups);
        setDefaultModel(nextDefaultModel);

        // A group is only a valid landing spot if it's actually configured.
        // Several engines can share a model *name* (e.g. "claude-sonnet-4-6"
        // is in both the keyless "anthropic" builtin and our local "vllm"
        // engine's list) — matching on model name alone can land on an
        // unconfigured engine and get stuck there (CORE-PATCHES.md #2).
        const findDefaultGroup = () =>
          groups.find(
            (group) => group.configured && group.models.includes(nextDefaultModel),
          ) ??
          groups.find((group) => group.configured) ??
          groups.find((group) => group.models.includes(nextDefaultModel)) ??
          groups[0];

        const selection = selectionRef.current;
        if (!hasExplicitSelectionRef.current) {
          const defaultGroup = findDefaultGroup();
          const nextModel =
            defaultGroup?.models.find((model) => model === nextDefaultModel) ??
            defaultGroup?.models[0] ??
            nextDefaultModel;
          const nextEngine = defaultGroup?.engine ?? "";
          const effortOptions = getReasoningEffortOptionsForModel(nextModel);
          const nextEffort =
            selection.selectedEffort === "auto" ||
            effortOptions.includes(selection.selectedEffort)
              ? selection.selectedEffort
              : "auto";
          setSelectedModel(nextModel);
          setSelectedEngine(nextEngine);
          setSelectedEffort(nextEffort);
          return;
        }

        const selectedGroup = groups.find(
          (group) =>
            group.configured &&
            group.models.includes(selection.selectedModel) &&
            (!selection.selectedEngine ||
              group.engine === selection.selectedEngine),
        );
        if (!selectedGroup) {
          const defaultGroup = findDefaultGroup();
          const nextModel =
            defaultGroup?.models.find((model) => model === nextDefaultModel) ??
            defaultGroup?.models[0] ??
            nextDefaultModel;
          const nextEngine = defaultGroup?.engine ?? "";
          const effortOptions = getReasoningEffortOptionsForModel(nextModel);
          const nextEffort =
            selection.selectedEffort === "auto" ||
            effortOptions.includes(selection.selectedEffort)
              ? selection.selectedEffort
              : "auto";
          setSelectedModel(nextModel);
          setSelectedEngine(nextEngine);
          setSelectedEffort(nextEffort);
          writePersisted(storageKey, {
            model: nextModel,
            engine: nextEngine,
            effort: nextEffort,
          });
        }
      })
      .catch(() => {});
  }, [enabled, storageKey]);

  useEffect(() => {
    if (!enabled) return;
    refreshEngines();
  }, [enabled, refreshEngines]);

  return {
    availableModels,
    defaultModel,
    selectedModel,
    selectedEngine,
    selectedEffort,
    onModelChange,
    onEffortChange,
    refreshEngines,
  };
}
