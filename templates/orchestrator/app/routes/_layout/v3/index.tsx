import { useNavigate } from "react-router";
import { APP_TITLE } from "@/lib/app-config";
import { Button } from "@/components/ui/button";

export function meta() {
  return [{ title: `${APP_TITLE} — V3` }];
}

const NAV_ITEMS = [
  { to: "/v3/runs", label: "Runs" },
  { to: "/v3/templates", label: "Templates" },
  { to: "/v3/agents", label: "Agents" },
  { to: "/v3/workspaces", label: "Workspaces" },
  { to: "/v3/spawns", label: "Spawns" },
];

export default function V3HomeRoute() {
  const navigate = useNavigate();

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          V3 Workflow Engine
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Workflow execution, templates, agents, and workspaces.
        </p>
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
