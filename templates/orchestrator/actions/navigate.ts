import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { writeAppState } from "@agent-native/core/application-state";

// Orchestrator views. v1 views (home/task/workflows/workflow/runs/run) are
// retained; P3d adds the PM surfaces (board/projects/project/library/item) so
// the agent's view-screen knows which PM screen the user is on (FRONTEND §0
// application-state writes / DESIGN §2a).
const VIEWS = [
  "home",
  "board",
  "task",
  "item",
  "projects",
  "project",
  "workflows",
  "workflow",
  "library",
  "runs",
  "run",
] as const;

function pathFor(view: string, id?: string): string {
  switch (view) {
    case "board":
      return "/board";
    case "task":
      return id ? `/tasks/${id}` : "/";
    case "item":
      return id ? `/items/${id}` : "/board";
    case "projects":
      return "/projects";
    case "project":
      return id ? `/projects/${id}` : "/projects";
    case "workflows":
      return "/workflows";
    case "workflow":
      return id ? `/workflows/${id}` : "/workflows";
    case "library":
      return "/library";
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
    "Navigate the UI. Views: home (task board), board (PM kanban), task/item (needs id), projects, project (needs id), workflows, workflow (needs id), library, runs, run (run console, needs id).",
  schema: z.object({
    view: z.enum(VIEWS).optional(),
    id: z
      .string()
      .optional()
      .describe("Task / work-item / project / workflow / run id for detail views"),
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
