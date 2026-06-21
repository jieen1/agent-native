import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  IconBolt,
  IconClock,
  IconDeviceFloppy,
  IconLoader2,
  IconRobot,
  IconSettingsBolt,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CRON_PRESETS,
  CUSTOM_CRON_PRESET_ID,
  describeCron,
  looksLikeCron,
  presetIdForCron,
} from "@/lib/cron";
import {
  useSaveRoutine,
  useTriggerEvents,
  type RoutineKind,
} from "@/hooks/use-routines";
import { RoutineDryRunButton } from "@/components/routines/RoutineDryRunButton";

/** Execution mode: full agent loop vs. a single fixed deterministic step. */
export type RoutineExecutionMode = "agentic" | "deterministic";

export interface RoutineFormInitialValues {
  /** Slug name when editing an existing routine; absent when creating. */
  name?: string;
  displayName: string;
  /** "schedule" (cron) or "event" (bus event). Defaults to schedule. */
  kind: RoutineKind;
  schedule: string;
  /** Subscribed event name (event kind). */
  event?: string;
  /**
   * Emitting app id for a cross-app event (event kind). Undefined for a
   * same-process event. Preserved so editing a cross-app routine keeps its
   * source even if the event list cannot be loaded.
   */
  sourceApp?: string;
  /** Natural-language condition gating dispatch (event kind). */
  condition?: string;
  instructions: string;
  enabled: boolean;
  /** "agentic" (default) or "deterministic" single-step. */
  executionMode: RoutineExecutionMode;
  /**
   * JSON declaration of the single deterministic step (deterministic mode only).
   * Prefilled from the routine body when editing a deterministic routine.
   */
  stepDeclaration?: string;
}

/** Starter template shown when switching a fresh routine to deterministic mode. */
const DETERMINISTIC_TEMPLATE = `{
  "kind": "web-request",
  "method": "POST",
  "url": "\${keys.WEBHOOK_URL}",
  "headers": { "Content-Type": "application/json" },
  "body": "{\\"text\\":\\"hello from my routine\\"}"
}`;

interface RoutineFormProps {
  mode: "create" | "update";
  initial: RoutineFormInitialValues;
}

const DEFAULT_SCHEDULE = "0 8 * * *";

/**
 * Create/edit form shared by `routines/new` and `routines/:name`.
 *
 * Phase A2 adds a kind switch (schedule / event):
 *  - schedule: cron input + live `describeCron` echo + presets (A1).
 *  - event: an event dropdown sourced from `list-trigger-events` plus an
 *    optional natural-language `condition` textarea. `mode` is fixed to
 *    `agentic` and is NOT surfaced — the deterministic option lands in A4.
 *
 * The cron is echoed via the pure client `describeCron`; the server
 * re-validates on save and is the source of truth.
 */
export function RoutineForm({ mode, initial }: RoutineFormProps) {
  const navigate = useNavigate();
  const save = useSaveRoutine();

  const [displayName, setDisplayName] = useState(initial.displayName);
  const [kind, setKind] = useState<RoutineKind>(initial.kind);
  const [schedule, setSchedule] = useState(
    initial.schedule || DEFAULT_SCHEDULE,
  );
  const [eventName, setEventName] = useState(initial.event ?? "");
  // Cross-app source id for the selected event. Set when the chosen event comes
  // from a sibling app, cleared for a same-process event. Persisted so the
  // bridge poller delivers cross-app events.
  const [sourceApp, setSourceApp] = useState<string | undefined>(
    initial.sourceApp,
  );
  const [condition, setCondition] = useState(initial.condition ?? "");
  const [instructions, setInstructions] = useState(initial.instructions);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [executionMode, setExecutionMode] = useState<RoutineExecutionMode>(
    initial.executionMode,
  );
  const [stepDeclaration, setStepDeclaration] = useState(
    initial.stepDeclaration ?? "",
  );

  const presetId = presetIdForCron(schedule);
  const scheduleValid = looksLikeCron(schedule);
  const humanCron = useMemo(
    () => (scheduleValid ? describeCron(schedule) : ""),
    [schedule, scheduleValid],
  );

  const isEdit = mode === "update";
  const isEvent = kind === "event";
  const isDeterministic = executionMode === "deterministic";

  // Client-side JSON shape check for the step declaration. The server
  // re-validates with the shared Zod schema and is the source of truth; this is
  // just an early, friendly gate so the Save button reflects validity.
  const stepDeclarationError = useMemo(
    () => validateStepDeclaration(stepDeclaration),
    [stepDeclaration],
  );

  // The save inputs are valid when the kind-specific required field is present
  // and, for deterministic mode, the step declaration parses as JSON.
  const kindValid = isEvent ? eventName.trim().length > 0 : scheduleValid;
  const modeValid = !isDeterministic || stepDeclarationError === null;

  function handlePresetChange(value: string) {
    if (value === CUSTOM_CRON_PRESET_ID) return;
    const preset = CRON_PRESETS.find((entry) => entry.id === value);
    if (preset) setSchedule(preset.cron);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    const trimmedName = displayName.trim();
    if (!isEdit && !trimmedName) {
      toast.error("Give the routine a name.");
      return;
    }
    if (isEvent) {
      if (!eventName.trim()) {
        toast.error("Choose an event for this routine to react to.");
        return;
      }
    } else if (!looksLikeCron(schedule)) {
      toast.error("Enter a valid 5-field cron schedule.");
      return;
    }
    if (isDeterministic && stepDeclarationError) {
      toast.error(stepDeclarationError);
      return;
    }

    try {
      const result = await save.mutateAsync({
        mode,
        kind,
        executionMode,
        ...(isEdit ? { name: initial.name } : {}),
        displayName: trimmedName || undefined,
        // Send the kind-specific fields; the action clears the others.
        ...(isEvent
          ? {
              event: eventName.trim(),
              // Cross-app source id (undefined for a same-process event); the
              // action persists it so the bridge poller delivers the event.
              sourceApp: sourceApp || undefined,
              condition: condition.trim() || undefined,
            }
          : { schedule: schedule.trim() }),
        // Deterministic routines carry the step declaration instead of the
        // natural-language instructions; the server validates it before write.
        ...(isDeterministic
          ? { stepDeclaration: stepDeclaration.trim() }
          : { instructions }),
        enabled,
      });
      const savedName =
        (result as { routine?: { name?: string } })?.routine?.name ??
        initial.name;
      toast.success(isEdit ? "Routine updated." : "Routine created.");
      navigate(savedName ? `/routines/${savedName}` : "/routines");
    } catch {
      // useSaveRoutine surfaces the server error message via toast.
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-auto w-full max-w-2xl space-y-6"
    >
      <Card>
        <CardHeader>
          <CardTitle>{isEdit ? "Edit routine" : "New routine"}</CardTitle>
          <CardDescription>
            {isEvent
              ? "An event routine runs your instructions when a chosen event fires."
              : "A scheduled routine runs your instructions on a cron schedule."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="routine-name">Name</Label>
            <Input
              id="routine-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={isEvent ? "On new plan" : "Morning briefing"}
              autoFocus={!isEdit}
            />
            {isEdit && initial.name ? (
              <p className="text-xs text-muted-foreground">
                File: <code className="font-mono">jobs/{initial.name}.md</code>
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The display name; the file name is derived automatically.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Trigger</Label>
            <Tabs
              value={kind}
              onValueChange={(value) => setKind(value as RoutineKind)}
            >
              <TabsList className="grid w-full grid-cols-2 sm:w-72">
                <TabsTrigger value="schedule" className="gap-1.5">
                  <IconClock className="size-3.5" />
                  Schedule
                </TabsTrigger>
                <TabsTrigger value="event" className="gap-1.5">
                  <IconBolt className="size-3.5" />
                  Event
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {isEvent ? (
            <EventFields
              eventName={eventName}
              sourceApp={sourceApp}
              onEventChange={(name, nextSourceApp) => {
                setEventName(name);
                // Selecting a cross-app event sets its source so the routine is
                // delivered by the bridge poller; a same-process event clears it.
                setSourceApp(nextSourceApp);
              }}
              condition={condition}
              onConditionChange={setCondition}
            />
          ) : (
            <ScheduleFields
              presetId={presetId}
              schedule={schedule}
              scheduleValid={scheduleValid}
              humanCron={humanCron}
              onPresetChange={handlePresetChange}
              onScheduleChange={setSchedule}
            />
          )}

          <div className="space-y-2">
            <Label>Mode</Label>
            <Tabs
              value={executionMode}
              onValueChange={(value) => {
                const next = value as RoutineExecutionMode;
                setExecutionMode(next);
                // Seed a starter declaration the first time a fresh routine
                // switches to deterministic, so the editor isn't blank.
                if (next === "deterministic" && !stepDeclaration.trim()) {
                  setStepDeclaration(DETERMINISTIC_TEMPLATE);
                }
              }}
            >
              <TabsList className="grid w-full grid-cols-2 sm:w-72">
                <TabsTrigger value="agentic" className="gap-1.5">
                  <IconRobot className="size-3.5" />
                  Agentic
                </TabsTrigger>
                <TabsTrigger value="deterministic" className="gap-1.5">
                  <IconSettingsBolt className="size-3.5" />
                  Deterministic
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-xs text-muted-foreground">
              {isDeterministic
                ? "Runs one fixed step (an HTTP request or a registered action) with no AI in the loop."
                : "Runs your natural-language instructions through the agent each time the routine fires."}
            </p>
          </div>

          {isDeterministic ? (
            <DeterministicFields
              value={stepDeclaration}
              onChange={setStepDeclaration}
              error={stepDeclarationError}
            />
          ) : (
            <div className="space-y-2">
              <Label htmlFor="routine-instructions">Instructions</Label>
              <Textarea
                id="routine-instructions"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Describe what the agent should do each time this routine runs."
                rows={6}
              />
            </div>
          )}

          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
            <div className="space-y-0.5">
              <Label htmlFor="routine-enabled" className="cursor-pointer">
                Enabled
              </Label>
              <p className="text-xs text-muted-foreground">
                {isEvent
                  ? "When off, the routine is unsubscribed and never reacts."
                  : "When off, the scheduler skips this routine."}
              </p>
            </div>
            <Switch
              id="routine-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
        {isEdit && initial.name ? (
          <RoutineDryRunButton name={initial.name} kind={kind} />
        ) : (
          <span className="hidden sm:block" />
        )}
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              navigate(
                isEdit && initial.name
                  ? `/routines/${initial.name}`
                  : "/routines",
              )
            }
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={save.isPending || !kindValid || !modeValid}
          >
            {save.isPending ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              <IconDeviceFloppy className="size-4" />
            )}
            {isEdit ? "Save changes" : "Create routine"}
          </Button>
        </div>
      </div>
    </form>
  );
}

interface ScheduleFieldsProps {
  presetId: string;
  schedule: string;
  scheduleValid: boolean;
  humanCron: string;
  onPresetChange: (value: string) => void;
  onScheduleChange: (value: string) => void;
}

function ScheduleFields({
  presetId,
  schedule,
  scheduleValid,
  humanCron,
  onPresetChange,
  onScheduleChange,
}: ScheduleFieldsProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="routine-preset">Schedule</Label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={presetId} onValueChange={onPresetChange}>
          <SelectTrigger id="routine-preset" className="sm:w-56">
            <SelectValue placeholder="Choose a preset" />
          </SelectTrigger>
          <SelectContent>
            {CRON_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                {preset.label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM_CRON_PRESET_ID}>Custom</SelectItem>
          </SelectContent>
        </Select>
        <Input
          aria-label="Cron expression"
          value={schedule}
          onChange={(event) => onScheduleChange(event.target.value)}
          placeholder="0 8 * * *"
          className="font-mono sm:flex-1"
        />
      </div>
      <p
        className={
          scheduleValid
            ? "flex items-center gap-1.5 text-sm text-muted-foreground"
            : "flex items-center gap-1.5 text-sm text-destructive"
        }
      >
        <IconClock className="size-3.5 shrink-0" />
        {scheduleValid
          ? humanCron || "Custom schedule"
          : "Enter a valid 5-field cron expression (minute hour day month weekday)."}
      </p>
    </div>
  );
}

interface EventFieldsProps {
  eventName: string;
  /** Source app of the currently selected event (cross-app events only). */
  sourceApp?: string;
  /**
   * Report a selection. The second arg is the chosen event's `sourceApp`
   * (undefined for a same-process event), resolved from the loaded list so the
   * caller can persist it without re-deriving.
   */
  onEventChange: (value: string, sourceApp?: string) => void;
  condition: string;
  onConditionChange: (value: string) => void;
}

function EventFields({
  eventName,
  sourceApp,
  onEventChange,
  condition,
  onConditionChange,
}: EventFieldsProps) {
  const { data, isLoading, isError } = useTriggerEvents();
  const events = data?.events ?? [];

  // Keep a selected-but-unlisted event (e.g. an event the process no longer
  // registers, or a cross-app event whose sibling is unreachable) visible so
  // editing an existing routine never loses its value.
  const selected = events.find((e) => e.name === eventName);
  const known = !!selected;
  const selectedDescription = selected?.description;

  function handleSelect(name: string) {
    // Resolve the chosen event's source app from the loaded list. A selection
    // that isn't in the list (the preserved current value) keeps its existing
    // sourceApp so an unreachable sibling never drops the cross-app binding.
    const match = events.find((e) => e.name === name);
    onEventChange(name, match ? match.sourceApp : sourceApp);
  }

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="routine-event">Event</Label>
        <Select value={eventName || undefined} onValueChange={handleSelect}>
          <SelectTrigger id="routine-event">
            <SelectValue
              placeholder={
                isLoading ? "Loading events…" : "Choose an event to react to"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {eventName && !known ? (
              <SelectItem value={eventName}>
                {eventLabel(eventName, sourceApp)}
              </SelectItem>
            ) : null}
            {events.map((option) => (
              <SelectItem key={option.name} value={option.name}>
                {eventLabel(option.name, option.sourceApp)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isError ? (
          <p className="text-sm text-destructive">
            Could not load the event list. You can still type a known event name
            and save.
          </p>
        ) : selectedDescription ? (
          <p className="text-sm text-muted-foreground">{selectedDescription}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            The routine runs each time this event fires for you.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="routine-condition">
          Condition{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="routine-condition"
          value={condition}
          onChange={(event) => onConditionChange(event.target.value)}
          placeholder="e.g. the plan is a recap, or the email is from my manager"
          rows={2}
        />
        <p className="text-xs text-muted-foreground">
          A natural-language gate. When set, the event payload is checked
          against it before the routine runs — leave empty to run on every
          event.
        </p>
      </div>
    </>
  );
}

/**
 * Render an event option as `name (sourceApp)`: the dotted event name in mono,
 * plus an inline source-app pill for cross-app events. Same-process events
 * (no `sourceApp`) show just the name, so the source is always visible in the
 * dropdown — "事件名(来源 app)".
 */
function eventLabel(name: string, sourceApp?: string) {
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-xs">{name}</span>
      {sourceApp ? (
        <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
          {sourceApp}
        </span>
      ) : null}
    </span>
  );
}

interface DeterministicFieldsProps {
  value: string;
  onChange: (value: string) => void;
  /** Client-side validation error, or null when the JSON shape is acceptable. */
  error: string | null;
}

/**
 * Editor for a deterministic routine's single-step declaration. The body is a
 * raw JSON object — the server validates it with the shared
 * `deterministicStepSchema` and is the source of truth; this surfaces an early,
 * friendly shape error so the form reflects validity before a round-trip.
 */
function DeterministicFields({
  value,
  onChange,
  error,
}: DeterministicFieldsProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="routine-step">Step</Label>
      <Textarea
        id="routine-step"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={DETERMINISTIC_TEMPLATE}
        rows={10}
        className="font-mono text-xs"
        spellCheck={false}
      />
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          A single JSON object: a <code className="font-mono">web-request</code>{" "}
          (use <code className="font-mono">{"${keys.NAME}"}</code> for secrets)
          or an <code className="font-mono">action</code> call. No AI runs — the
          step executes exactly as written.
        </p>
      )}
    </div>
  );
}

/**
 * Lightweight client-side check for the deterministic step JSON. Returns a
 * human-readable error or null. Deliberately shallow — the server's Zod schema
 * is authoritative; this only catches empty/non-JSON/obviously-wrong shapes so
 * the Save button can reflect validity without a round-trip.
 */
function validateStepDeclaration(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "Add a JSON step declaration.";
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return "Step declaration must be valid JSON.";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "Step must be a single JSON object (not an array).";
  }
  const kind = (parsed as { kind?: unknown }).kind;
  if (kind !== "web-request" && kind !== "action") {
    return 'Step "kind" must be "web-request" or "action".';
  }
  if (kind === "web-request" && !(parsed as { url?: unknown }).url) {
    return 'A "web-request" step needs a "url".';
  }
  if (kind === "action" && !(parsed as { action?: unknown }).action) {
    return 'An "action" step needs an "action" name.';
  }
  return null;
}
