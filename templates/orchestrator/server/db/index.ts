import * as schema from "./schema.js";
import { createGetDb } from "@agent-native/core/db";
import { registerShareableResource } from "@agent-native/core/sharing";

export const getDb = createGetDb(schema);
export { schema };

registerShareableResource({
  type: "task",
  resourceTable: schema.tasks,
  sharesTable: schema.taskShares,
  displayName: "Task",
  titleColumn: "title",
  getResourcePath: (task) => `/tasks/${(task as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "workflow",
  resourceTable: schema.workflows,
  sharesTable: schema.workflowShares,
  displayName: "Workflow",
  titleColumn: "name",
  getResourcePath: (wf) => `/workflows/${(wf as { id: string }).id}`,
  getDb,
});

// ── v2 graph engine ownable resources ──────────────────────────────────────

registerShareableResource({
  type: "workflow_template",
  resourceTable: schema.workflowTemplates,
  sharesTable: schema.workflowTemplateShares,
  displayName: "Workflow Template",
  titleColumn: "name",
  getResourcePath: (t) => `/templates/${(t as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "workflow_run",
  resourceTable: schema.workflowRuns,
  sharesTable: schema.workflowRunShares,
  displayName: "Workflow Run",
  titleColumn: "id",
  getResourcePath: (r) => `/runs/${(r as { id: string }).id}`,
  getDb,
});
