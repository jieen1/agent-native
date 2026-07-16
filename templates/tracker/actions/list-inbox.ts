import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import { buildInboxGroups } from "../server/lib/inbox.js";

export default defineAction({
  description:
    "List everything waiting on a human decision — the tracker inbox (/inbox). " +
    "Groups: signoff (pending plan/design-signoff approvals), escalation " +
    "(pending escalation/audit-deferral approvals), reviewRequest (work items " +
    "at 验收 awaiting human review — done's only human entry point), " +
    "failedRouting (work items whose run permanently failed), notifications " +
    "(currently always empty — no cross-item event feed exists yet). Use this " +
    "to answer 'what needs my attention' or 'what's in the inbox'.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    const db = getDb();
    return buildInboxGroups(db);
  },
});
