import * as schema from "./schema.js";
import { createGetDb, getDbExec } from "@agent-native/core/db";
import { registerShareableResource } from "@agent-native/core/sharing";

export const getDb = createGetDb(schema);
// Re-export the raw db-exec client (used by the queue's portable atomic claim /
// reap, which need affected-row counts that the Drizzle query builder does not
// surface) so the rest of the app imports it through one local module.
export { schema, getDbExec };

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

// ── v2 project-management ownable resources (P3a) ───────────────────────────

registerShareableResource({
  type: "project",
  resourceTable: schema.projects,
  sharesTable: schema.projectShares,
  displayName: "Project",
  titleColumn: "name",
  getResourcePath: (p) => `/projects/${(p as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "work_item",
  resourceTable: schema.workItems,
  sharesTable: schema.workItemShares,
  displayName: "Work Item",
  titleColumn: "title",
  getResourcePath: (w) => `/work-items/${(w as { id: string }).id}`,
  getDb,
});

registerShareableResource({
  type: "node_def",
  resourceTable: schema.nodeDefs,
  sharesTable: schema.nodeDefShares,
  displayName: "Node Definition",
  titleColumn: "title",
  getResourcePath: (n) => `/library/${(n as { id: string }).id}`,
  getDb,
});
