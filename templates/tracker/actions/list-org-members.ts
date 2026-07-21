import { defineAction } from "@agent-native/core";
import { orgMembers } from "@agent-native/core/org";
import {
  getRequestOrgId,
  getRequestUserEmail,
} from "@agent-native/core/server/request-context";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../server/db/index.js";

export default defineAction({
  description:
    "List members of the current organization, as owner (负责人) candidates for a work item.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    const orgId = getRequestOrgId();
    const currentUser = getRequestUserEmail() ?? null;
    if (!orgId) {
      return {
        members: currentUser ? [{ email: currentUser, role: "owner" }] : [],
      };
    }
    const rows = await getDb()
      .select({ email: orgMembers.email, role: orgMembers.role })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, orgId))
      .orderBy(asc(orgMembers.email));
    return { members: rows };
  },
});
