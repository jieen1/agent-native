import { useNavigate } from "react-router";
import { APP_TITLE } from "@/lib/app-config";
import { Button } from "@/components/ui/button";

export function meta() {
  return [{ title: APP_TITLE }];
}

const NAV_ITEMS = [
  { to: "/runs", label: "Runs" },
  { to: "/workflows", label: "Workflows" },
  { to: "/agents", label: "Agents" },
  { to: "/workspaces", label: "Workspaces" },
  { to: "/spawns", label: "Spawns" },
  { to: "/pool", label: "Pool" },
];

export default function V3HomeRoute() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            Orchestrator
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Workflow execution, templates, agents, and workspaces.
          </p>
        </div>
      </header>
      <nav className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {NAV_ITEMS.map((item) => (
          <Button
            key={item.to}
            variant="outline"
            className="h-auto justify-start p-3"
            onClick={() => navigate(item.to)}
          >
            <span className="text-sm font-medium">{item.label}</span>
          </Button>
        ))}
      </nav>
    </div>
  );
}
