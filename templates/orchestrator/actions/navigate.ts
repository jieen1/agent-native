import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { writeAppState } from "@agent-native/core/application-state";

// Orchestrator views: home (task board), task (detail), workflows, workflow,
// runs (run list), run (run console).
const VIEWS = ["home", "task", "workflows", "workflow", "runs", "run"] as const;

function pathFor(view: string, id?: string): string {
  switch (view) {
    case "task":
      return id ? `/tasks/${id}` : "/";
    case "workflows":
      return "/workflows";
    case "workflow":
      return id ? `/workflows/${id}` : "/workflows";
    case "runs":
      return "/runs";
    case "run":
      return id ? `/runs/${id}` : "/runs";
    default:
      return "/";
  }
}

export default defineAction({
  description:
    "Navigate the UI. Views: home (task board), task (needs id), workflows, workflow (needs id), runs (run list), run (run console, needs id).",
  schema: z.object({
    view: z.enum(VIEWS).optional(),
    id: z.string().optional().describe("Task or workflow id for detail views"),
    path: z.string().optional().describe("Explicit URL path override"),
  }),
  http: false,
  run: async (args) => {
    if (!args.view && !args.path) {
      throw new Error("At least view or path is required.");
    }
    const nav: Record<string, string> = {};
    if (args.view) nav.view = args.view;
    if (args.id) nav.id = args.id;
    nav.path = args.path ?? pathFor(args.view ?? "home", args.id);
    nav._writeId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await writeAppState("navigate", nav);
    return `Navigating to ${nav.path}`;
  },
});
