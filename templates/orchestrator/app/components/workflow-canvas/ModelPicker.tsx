import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCheck, IconChevronDown, IconServer2 } from "@tabler/icons-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useRuntimeConfigs } from "@/hooks/use-orchestrator";
import { pickerModelsFor } from "../../../shared/model-list";
import { cn } from "@/lib/utils";

// The §8.5 engine/model picker — a CUSTOM dropdown (popover + command), NOT the
// framework chat composer picker. It is fed by the built-in engine white-list
// PLUS the user's registered runtime configs (list-runtime-configs: vLLM /
// OpenAI-compatible / Claude Code). P4a only WRITES the chosen {engine, model}
// into the in-memory graph node; per-node routing actually taking effect is P5.

export interface EngineOption {
  engine: string;
  model: string;
  label: string;
  source: "builtin" | "runtime";
}

// Built-in engine white-list (DESIGN §1.6 / §8.5). Stable ids the engine layer
// understands; the model is a sensible default the user can leave or override.
const BUILTIN_ENGINES: EngineOption[] = [
  {
    engine: "anthropic",
    model: "claude-opus-4-8",
    label: "Anthropic · Opus",
    source: "builtin",
  },
  {
    engine: "anthropic",
    model: "claude-sonnet-4-6",
    label: "Anthropic · Sonnet",
    source: "builtin",
  },
  {
    engine: "ai-sdk-harness:claude-code",
    model: "claude-opus-4-8",
    label: "Claude Code (subscription)",
    source: "builtin",
  },
  {
    engine: "ai-sdk:openai",
    model: "gpt-5.5",
    label: "OpenAI · GPT-5.5",
    source: "builtin",
  },
];

export interface ModelPickerProps {
  engine?: string;
  model?: string;
  onChange: (value: { engine?: string; model?: string }) => void;
}

export function ModelPicker({ engine, model, onChange }: ModelPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data: runtimes = [] } = useRuntimeConfigs();

  // Each runtime's per-node options come straight from the SAVED runtime_configs
  // row — its `model` plus any extra `models` it serves (DESIGN §8.3 item4) — NOT
  // a re-registered template engine (the dual-registry pitfall, §8.5.1). A vLLM /
  // OpenAI-compatible runtime maps to the built-in `ai-sdk:openai` engine; a
  // single endpoint serving several models yields one option per model.
  const runtimeOptions: EngineOption[] = useMemo(
    () =>
      runtimes.flatMap((r) => {
        const engineId =
          r.kind === "claude-code"
            ? "ai-sdk-harness:claude-code"
            : "ai-sdk:openai";
        // Union of the activation default `model` + the extra `models` list,
        // de-duped, order-preserving. Empty → a single label-only option.
        const models = pickerModelsFor(r.model, r.models);
        if (models.length === 0) {
          return [
            {
              engine: engineId,
              model: "",
              label: r.name,
              source: "runtime" as const,
            },
          ];
        }
        return models.map((m) => ({
          engine: engineId,
          model: m,
          label: `${r.name} · ${m}`,
          source: "runtime" as const,
        }));
      }),
    [runtimes],
  );

  const current = [engine, model].filter(Boolean).join(" · ");
  const isSelected = (opt: EngineOption) =>
    opt.engine === engine && (opt.model || "") === (model || "");

  function choose(opt: EngineOption | null) {
    if (!opt) {
      onChange({ engine: undefined, model: undefined });
    } else {
      onChange({ engine: opt.engine, model: opt.model || undefined });
    }
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-background px-3 text-left text-sm",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <IconServer2 className="size-4 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              current ? "" : "text-muted-foreground",
            )}
          >
            {current || t("flow.engineDefault")}
          </span>
          <IconChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
      >
        <Command>
          <CommandInput placeholder={t("flow.engineSearch")} />
          <CommandList>
            <CommandEmpty>{t("flow.engineEmpty")}</CommandEmpty>
            <CommandGroup heading={t("flow.engineDefaultGroup")}>
              <CommandItem value="__default__" onSelect={() => choose(null)}>
                <IconCheck
                  className={cn(
                    "size-4",
                    !engine ? "opacity-100" : "opacity-0",
                  )}
                />
                {t("flow.engineDefault")}
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading={t("flow.engineBuiltin")}>
              {BUILTIN_ENGINES.map((opt) => (
                <CommandItem
                  key={`b-${opt.engine}-${opt.model}`}
                  value={`${opt.label} ${opt.engine} ${opt.model}`}
                  onSelect={() => choose(opt)}
                >
                  <IconCheck
                    className={cn(
                      "size-4",
                      isSelected(opt) ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
            {runtimeOptions.length > 0 ? (
              <CommandGroup heading={t("flow.engineRuntimes")}>
                {runtimeOptions.map((opt, i) => (
                  <CommandItem
                    key={`r-${i}-${opt.model}`}
                    value={`${opt.label} ${opt.engine} ${opt.model}`}
                    onSelect={() => choose(opt)}
                  >
                    <IconCheck
                      className={cn(
                        "size-4",
                        isSelected(opt) ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {opt.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
