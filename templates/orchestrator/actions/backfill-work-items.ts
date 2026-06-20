import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { z } from "zod";
import { backfillTasksForOwner } from "../server/work-items/backfill.js";

// v1 → v2 backfill (DESIGN §9): copy each v1 task into a v2 work_item (type
// task) under an owner-scoped holding project, preserving an id mapping. One-way
// and NON-destructive — v1 tasks/workflows/step_runs are never modified.
// IDEMPOTENT: re-running adds no duplicate rows.
export default defineAction({
  description:
    "Backfill the caller's v1 tasks into v2 work items (one-way, non-destructive, idempotent). Copies each task into a work_item under an owner-scoped holding project. Returns counts.",
  schema: z.object({}),
  run: async () => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();
    const result = await backfillTasksForOwner(ownerEmail, orgId ?? null);
    return result;
  },
});
