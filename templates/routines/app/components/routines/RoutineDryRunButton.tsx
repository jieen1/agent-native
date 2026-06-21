import { useState } from "react";
import {
  IconArrowRight,
  IconLoader2,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  useOpenChatThread,
  useRunRoutine,
  type RoutineKind,
  type RunRoutineResult,
} from "@/hooks/use-routines";
import { describeRunResult } from "@/lib/run-result";

interface RoutineDryRunButtonProps {
  name: string;
  kind: RoutineKind;
}

/**
 * "Try it once" — a manual dry-run for the routine being edited (§A2 dry-run).
 *
 * Schedule routines run immediately through the agent (server-side `run-routine`
 * never advances `nextRun`); on success we offer a jump to the created chat
 * thread. Event routines need a sample payload, so they open a small dialog: the
 * user supplies a JSON payload, the server evaluates the NL condition against it
 * and dispatches through the real event path, and we report match / no-match.
 */
export function RoutineDryRunButton({ name, kind }: RoutineDryRunButtonProps) {
  if (kind === "event") {
    return <EventDryRun name={name} />;
  }
  return <ScheduleDryRun name={name} />;
}

/** Map the structured run outcome to a toast (with an optional thread jump). */
function reportRunResult(
  result: RunRoutineResult,
  openThread: (id: string) => void,
): void {
  const outcome = describeRunResult(result);
  const action = outcome.threadId
    ? {
        label: "Open thread",
        onClick: () => openThread(outcome.threadId as string),
      }
    : undefined;

  if (outcome.tone === "error") {
    toast.error(outcome.title, { description: outcome.description, action });
    return;
  }
  if (outcome.tone === "success") {
    toast.success(outcome.title, { description: outcome.description, action });
    return;
  }
  toast.message(outcome.title, { description: outcome.description });
}

function ScheduleDryRun({ name }: { name: string }) {
  const run = useRunRoutine();
  const openThread = useOpenChatThread();

  async function handleRun() {
    try {
      const result = await run.mutateAsync({ name });
      reportRunResult(result, openThread);
    } catch {
      // useRunRoutine surfaces the server error via toast.
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      onClick={() => void handleRun()}
      disabled={run.isPending}
    >
      {run.isPending ? (
        <IconLoader2 className="size-4 animate-spin" />
      ) : (
        <IconPlayerPlay className="size-4" />
      )}
      Try it once
    </Button>
  );
}

const DEFAULT_SAMPLE = "{\n  \n}";

function EventDryRun({ name }: { name: string }) {
  const run = useRunRoutine();
  const openThread = useOpenChatThread();
  const [open, setOpen] = useState(false);
  const [payloadText, setPayloadText] = useState(DEFAULT_SAMPLE);
  const [jsonError, setJsonError] = useState<string | null>(null);

  async function handleRun() {
    let samplePayload: Record<string, unknown> = {};
    const trimmed = payloadText.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          setJsonError("The sample payload must be a JSON object.");
          return;
        }
        samplePayload = parsed as Record<string, unknown>;
      } catch {
        setJsonError("That isn't valid JSON. Fix it or clear the field.");
        return;
      }
    }
    setJsonError(null);

    try {
      const result = await run.mutateAsync({ name, samplePayload });
      reportRunResult(result, openThread);
      setOpen(false);
    } catch {
      // useRunRoutine surfaces the server error via toast.
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <IconPlayerPlay className="size-4" />
          Try it once
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Try this event routine</DialogTitle>
          <DialogDescription>
            Provide a sample event payload. The condition is evaluated against
            it, and if it matches the routine is dispatched through the real
            event path.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="dry-run-payload">Sample payload (JSON)</Label>
          <Textarea
            id="dry-run-payload"
            value={payloadText}
            onChange={(event) => {
              setPayloadText(event.target.value);
              if (jsonError) setJsonError(null);
            }}
            rows={6}
            className="font-mono text-xs"
            placeholder='{ "plan": { "kind": "recap" } }'
          />
          {jsonError ? (
            <p className="text-sm text-destructive">{jsonError}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Leave empty to test with no payload. A condition with no payload
              fields usually will not match.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={run.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleRun()}
            disabled={run.isPending}
          >
            {run.isPending ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              <IconArrowRight className="size-4" />
            )}
            Evaluate & dispatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
