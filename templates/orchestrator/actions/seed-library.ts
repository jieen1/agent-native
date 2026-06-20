import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { z } from "zod";
import { getDb } from "../server/db/index.js";
import { seedStarterLibrary } from "../server/library/seed.js";

// Seed the starter node library + the bundled `code-change-with-review` template
// (DESIGN §3.7 / §1.9). Idempotent: re-running updates existing entries (matched
// by key / name for the owner) rather than duplicating them. The seed is the
// vetted gate set the brain composes — fixed every run.
export default defineAction({
  description:
    "Seed the starter node library (deterministic tool nodes run-tests/lint/git-commit/git-push/open-pr/apply-patch/finalize-status + parameterized agent nodes code-review/security-review/secret-scan/pr-description) and the bundled code-change-with-review template. Idempotent.",
  schema: z.object({}),
  run: async () => {
    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const orgId = getRequestOrgId() ?? null;
    const db = getDb();
    const result = await seedStarterLibrary(db, ownerEmail, orgId);
    return result;
  },
});
