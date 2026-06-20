import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";

// Create or update a reusable node-library entry (DESIGN §3.7 / §9 `node_defs`).
// A library entry is a pre-configured, named node (`key`) that graphs reference
// by `nodeDefKey`; `config` is the pinned node config the dropped graph node
// inherits (overridable per-use); `version` lets a workflow pin a known-good
// gate. Pass `id` to update an existing entry, else a new one is created.
// Ownable-scoped: only the owner/admin may update.
export default defineAction({
  description:
    "Create or update a reusable node-library entry (node_defs, DESIGN §3.7). `key` is referenced from a graph by nodeDefKey; `kind` is the node type flavor (tool|agent); `config` is the pinned node config (JSON, overridable per-use); `version` pins a known-good gate. Pass `id` to update.",
  schema: z.object({
    id: z.string().optional().describe("Update an existing entry by id"),
    key: z
      .string()
      .min(1)
      .describe("Stable library key referenced by a graph node's nodeDefKey"),
    kind: z.string().min(1).describe("Node flavor, e.g. 'tool' or 'agent'"),
    title: z.string().optional(),
    config: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe("Pinned node config (partial Node) or its JSON string"),
    version: z.coerce.number().int().positive().optional(),
  }),
  run: async (args) => {
    const configJson =
      args.config === undefined
        ? "{}"
        : typeof args.config === "string"
          ? args.config
          : JSON.stringify(args.config);
    // Validate the config parses to an object (fail fast at the boundary).
    try {
      const parsed = JSON.parse(configJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("config must be a JSON object");
      }
    } catch (err) {
      throw new Error(
        `Invalid node-def config: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const db = getDb();
    const now = nowIso();
    const key = args.key.trim();
    if (!key) throw new Error("Node-def key is required");

    if (args.id) {
      const access = await resolveAccess("node_def", args.id);
      if (!access) throw new Error(`Node def ${args.id} not found`);
      if (access.role === "viewer") throw new Error("Read-only access");
      const current = access.resource as { version?: number };
      await db
        .update(schema.nodeDefs)
        .set({
          key,
          kind: args.kind.trim(),
          title: args.title ?? "",
          config: configJson,
          version: args.version ?? (current.version ?? 1) + 1,
          updatedAt: now,
        })
        .where(eq(schema.nodeDefs.id, args.id));
      return { id: args.id, key, ok: true };
    }

    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();
    const id = newId("nd");
    await db.insert(schema.nodeDefs).values({
      id,
      key,
      kind: args.kind.trim(),
      title: args.title ?? "",
      config: configJson,
      version: args.version ?? 1,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });
    return { id, key, ok: true };
  },
});
