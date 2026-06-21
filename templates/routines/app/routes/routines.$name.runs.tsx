import { Link, useParams } from "react-router";
import { IconArrowLeft, IconPencil } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { RoutineRunsList } from "@/components/routines/RoutineRunsList";

export function meta() {
  return [{ title: "Run history" }];
}

export default function RoutineRunsPage() {
  const params = useParams();
  const name = params.name ?? "";
  useSetPageTitle(
    <h1 className="truncate text-lg font-semibold tracking-tight">
      Run history
    </h1>,
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to={`/routines/${name}`}>
            <IconArrowLeft className="size-4" />
            Back to routine
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link to={`/routines/${name}`}>
            <IconPencil className="size-4" />
            Edit
          </Link>
        </Button>
      </div>

      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Run history</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every run of <code className="font-mono text-foreground">{name}</code>{" "}
          — status, duration, and a jump to what the agent did.
        </p>
      </header>

      <RoutineRunsList name={name} />
    </div>
  );
}
