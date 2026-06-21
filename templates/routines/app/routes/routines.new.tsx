import { Link } from "react-router";
import { IconArrowLeft } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { RoutineForm } from "@/components/routines/RoutineForm";

export function meta() {
  return [{ title: "New routine" }];
}

export default function NewRoutinePage() {
  useSetPageTitle(
    <h1 className="truncate text-lg font-semibold tracking-tight">
      New routine
    </h1>,
  );
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6">
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
        <Link to="/routines">
          <IconArrowLeft className="size-4" />
          Routines
        </Link>
      </Button>
      <RoutineForm
        mode="create"
        initial={{
          displayName: "",
          kind: "schedule",
          schedule: "0 8 * * *",
          instructions: "",
          enabled: true,
          executionMode: "agentic",
        }}
      />
    </div>
  );
}
