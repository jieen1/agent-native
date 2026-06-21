import { Link, useParams } from "react-router";
import { IconArrowLeft, IconHistory } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { RoutineForm } from "@/components/routines/RoutineForm";
import { useRoutine } from "@/hooks/use-routines";

export function meta() {
  return [{ title: "Edit routine" }];
}

export default function EditRoutinePage() {
  const params = useParams();
  const name = params.name ?? "";
  useSetPageTitle(
    <h1 className="truncate text-lg font-semibold tracking-tight">
      Edit routine
    </h1>,
  );

  const { data, isLoading, isError, error } = useRoutine(name);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/routines">
            <IconArrowLeft className="size-4" />
            Routines
          </Link>
        </Button>
        {name ? (
          <Button asChild variant="outline" size="sm">
            <Link to={`/routines/${name}/runs`}>
              <IconHistory className="size-4" />
              Run history
            </Link>
          </Button>
        ) : null}
      </div>

      {isLoading ? (
        <FormSkeleton />
      ) : isError ? (
        <NotFoundCard
          name={name}
          message={
            error instanceof Error ? error.message : "Could not load routine."
          }
        />
      ) : !data || data.notFound || !data.routine ? (
        <NotFoundCard name={name} />
      ) : (
        <RoutineForm
          mode="update"
          initial={{
            name: data.routine.name,
            displayName: data.routine.name,
            kind: data.routine.kind,
            schedule: data.routine.schedule,
            event: data.routine.event,
            sourceApp: data.routine.sourceApp,
            condition: data.routine.condition,
            // Deterministic routines store the step declaration as a fenced
            // ```json body; agentic routines store natural-language instructions.
            instructions:
              data.routine.mode === "deterministic"
                ? ""
                : (data.instructions ?? ""),
            enabled: data.routine.enabled,
            executionMode:
              data.routine.mode === "deterministic"
                ? "deterministic"
                : "agentic",
            stepDeclaration:
              data.routine.mode === "deterministic"
                ? extractStepDeclaration(data.instructions ?? "")
                : undefined,
          }}
        />
      )}
    </div>
  );
}

/**
 * Pull the raw JSON out of a deterministic routine body. The body is stored as
 * a fenced ```json block (see save-routine); strip the fence so the editor shows
 * just the JSON. Falls back to the trimmed body when no fence is present.
 */
function extractStepDeclaration(body: string): string {
  const match = body.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return match ? match[1].trim() : body.trim();
}

function NotFoundCard({ name, message }: { name: string; message?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Routine not found</CardTitle>
        <CardDescription>
          {message ?? `No routine named "${name}" exists for your account.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <Link to="/routines">Back to routines</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function FormSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-5">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-14 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
