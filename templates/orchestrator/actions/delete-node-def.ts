import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { findTemplatesReferencingNodeDef } from "../server/library/references.js";

// Delete a node-library entry (DESIGN §3.7). BLOCKED when any workflow template's
// graph still references the entry's `key` (via a node's nodeDefKey) — deleting
// it would strand those graphs on a missing gate. The error lists the
// referencing templates so the user fixes them first. Identify the entry by
// `id` or `key`. HARD delete (a library entry, unlike a template, has no runs to
// keep loadable). Owner/admin-scoped.
export default defineAction({
  description:
    "Delete a node-library entry by id or key (DESIGN §3.7). BLOCKED when a workflow template's graph references the entry's key; the error lists the referencing templates so you fix them first.",
  schema: z
    .object({
      id: z.string().optional(),
      key: z.string().optional(),
    })
    .refine((v) => !!v.id || !!v.key, {
      message: "Provide id or key",
    }),
  run: async (args) => {
    const db = getDb();

    // Resolve the target row (by id, else by key — first owner-visible match).
    let id = args.id;
    let key = args.key;
    if (!id && key) {
      const byKey = await db
        .select({ id: schema.nodeDefs.id, key: schema.nodeDefs.key })
        .from(schema.nodeDefs)
        .where(eq(schema.nodeDefs.key, key))
        .limit(1);
      if (byKey.length === 0)
        throw new Error(`Node def with key '${key}' not found`);
      id = byKey[0].id;
      key = byKey[0].key;
    }
    if (!id) throw new Error("Node def not found");

    const access = await resolveAccess("node_def", id);
    if (!access) throw new Error(`Node def ${id} not found`);
    if (access.role !== "owner" && access.role !== "admin") {
      throw new Error("Only the owner can delete a node-library entry");
    }
    key = key ?? (access.resource as { key: string }).key;

    // BLOCK if referenced by any template graph (DESIGN §3.7).
    const refs = await findTemplatesReferencingNodeDef(key);
    if (refs.length > 0) {
      const list = refs
        .map(
          (r) => `${r.templateName} (${r.templateId}: ${r.nodeIds.join(", ")})`,
        )
        .join("; ");
      throw new Error(
        `Cannot delete node-library entry '${key}': it is referenced by ${refs.length} template(s): ${list}. Update those graphs first.`,
      );
    }

    await db.delete(schema.nodeDefs).where(eq(schema.nodeDefs.id, id));
    return { id, key, ok: true };
  },
});
