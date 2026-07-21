import fs from "node:fs";
import path from "node:path";

import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

// M5 度量复盘 — Sprint 发布 (release) action.
//
// Transitions a completed sprint (status === "已完成") to "已发布" and writes a
// pending changelog entry (the existing changelog mechanism: a small
// `changelog/<date>-<slug>.md` file that `agent-native changelog release` later
// rolls into CHANGELOG.md).
//
// IDEMPOTENT: if the sprint is already "已发布", this is a no-op — no error, no
// duplicate changelog entry, no double state transition. The guard is in the
// handler (not just the button), so repeated clicks / concurrent calls are safe.

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Write a pending changelog entry for the release. Deterministic filename
 *  keyed on sprint id so a second call (even if the status guard somehow
 *  raced) never writes a duplicate file. */
function writeReleaseChangelogEntry(sprintId: string, sprintName: string): void {
  const date = todayIso();
  // Deterministic slug: sprint id is unique, so the filename is unique per
  // sprint and stable across repeated calls.
  const slug = sprintId.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
  const filename = `${date}-sprint-released-${slug}.md`;
  const dir = path.resolve(process.cwd(), "changelog");
  const filePath = path.join(dir, filename);

  // Idempotency: if the file already exists (a previous release call wrote it),
  // skip — never overwrite or duplicate.
  if (fs.existsSync(filePath)) return;

  fs.mkdirSync(dir, { recursive: true });
  const content = [
    "---",
    "type: added",
    `date: ${date}`,
    "---",
    "",
    `Sprint "${sprintName}" 已发布。`,
    "",
  ].join("\n");
  fs.writeFileSync(filePath, content, "utf-8");
}

export default defineAction({
  description:
    "Release a completed sprint: transition status 已完成 → 已发布 and write a " +
    "pending changelog entry. Idempotent — calling on an already-released " +
    "sprint is a no-op (no error, no duplicate changelog entry).",
  schema: z.object({
    sprintId: z.string().min(1).describe("Sprint id to release"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const sprint = (
      await db
        .select()
        .from(schema.sprints)
        .where(
          and(eq(schema.sprints.id, args.sprintId), ownerScope(schema.sprints)),
        )
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found or not accessible");

    // ── Idempotency guard ──────────────────────────────────────────────────
    // Already released → no-op. No error, no duplicate changelog, no double
    // state transition. This is the authoritative guard; the UI button also
    // disables itself, but the handler must be safe on its own.
    if (sprint.status === "已发布") {
      return {
        id: sprint.id,
        status: sprint.status,
        alreadyReleased: true,
        changelogWritten: false,
      };
    }

    // ── Precondition: only completed sprints can be released ───────────────
    if (sprint.status !== "已完成") {
      throw new Error(
        `Sprint must be in "已完成" status to release (current: "${sprint.status}")`,
      );
    }

    // ── Transition: 已完成 → 已发布 ────────────────────────────────────────
    const now = new Date().toISOString();
    await db
      .update(schema.sprints)
      .set({ status: "已发布", updatedAt: now })
      .where(eq(schema.sprints.id, args.sprintId));

    // ── Changelog: write a pending entry (existing mechanism) ──────────────
    let changelogWritten = false;
    try {
      writeReleaseChangelogEntry(sprint.id, sprint.name);
      changelogWritten = true;
    } catch {
      // Best-effort: a changelog write failure (e.g. read-only filesystem in
      // some deploy targets) must not roll back the release itself. The
      // changelog entry can be added manually later.
    }

    return {
      id: sprint.id,
      status: "已发布",
      alreadyReleased: false,
      changelogWritten,
    };
  },
});
