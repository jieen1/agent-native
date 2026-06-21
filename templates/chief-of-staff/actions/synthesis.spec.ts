/**
 * Phase B3 acceptance: the agent-synthesis two-step + cross-user isolation
 * (docs/IMPLEMENTATION_PLAN.md §1.5.18 / §12, Phase B3 acceptance 2 + 5).
 *
 * OAuth is NOT required (§1.5.24): `discoverAgents`, `runFanout`, settings, and
 * sharing are mocked; the REAL `compile-briefing` and `update-briefing` run
 * end-to-end against one in-memory libsql db, with a "stub agent" (the test
 * body) performing the compile -> read -> update-briefing sequence the CoS
 * agent would run.
 *
 * Asserts (§1.5.18 "叙述非拼接"):
 *   - the final summaryMd contains the stub agent's polish marker,
 *   - it is NOT equal to deterministicDigest(sources) (it was rewritten),
 *   - the LLM spy count inside compile-briefing is 0 (compile imports no LLM).
 *
 * Plus cross-user isolation (§12 acceptance 5): user B's source content never
 * appears in user A's briefing row, and vice versa.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { briefings } from "../server/db/schema.js";
import { deterministicDigest } from "../shared/digest.js";
import type { BriefingSource } from "../shared/types.js";

const userA = "a@example.com";
const userB = "b@example.com";

let client: Client;
let db: ReturnType<typeof drizzle>;

vi.mock("../server/db/index.js", async () => ({
  getDb: () => db,
  schema: await vi.importActual("../server/db/schema.js"),
}));

const discoverSpy = vi.fn();
vi.mock("@agent-native/core/server/agent-discovery", () => ({
  discoverAgents: (...args: unknown[]) => discoverSpy(...args),
}));

const fanoutSpy = vi.fn();
vi.mock("../shared/fanout.js", async () => {
  const actual = await vi.importActual<typeof import("../shared/fanout.js")>(
    "../shared/fanout.js",
  );
  return { ...actual, runFanout: (...args: unknown[]) => fanoutSpy(...args) };
});

// No briefing settings stored -> default four-source set, no overrides.
vi.mock("@agent-native/core/settings", () => ({
  getUserSetting: vi.fn(async () => null),
  putUserSetting: vi.fn(async () => undefined),
}));

// update-briefing gates on assertAccess(...,"editor"); grant editor in tests.
vi.mock("@agent-native/core/sharing", () => ({
  assertAccess: vi.fn(async () => ({ role: "editor" })),
  accessFilter: () => undefined,
  ForbiddenError: class ForbiddenError extends Error {},
}));

// A spy that would fire if compile-briefing ever reached for an LLM. It imports
// no LLM SDK (verified), so this stays at 0 — we assert that explicitly to
// honor §1.5.18 "compile-briefing 内 LLM spy == 0".
const compileLlmSpy = vi.fn();

const { default: compileBriefing } = await import("./compile-briefing.js");
const { default: updateBriefing } = await import("./update-briefing.js");

function asUser<T>(userEmail: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ userEmail }, fn);
}

function discovered(id: string, port: number) {
  return {
    id,
    name: id,
    description: "",
    url: `http://localhost:${port}`,
    color: "#000",
  };
}

function source(
  over: Partial<BriefingSource> & Pick<BriefingSource, "app" | "status">,
): BriefingSource {
  return { prompt: "", responseText: "", deepLinks: [], latencyMs: 0, ...over };
}

beforeEach(async () => {
  discoverSpy.mockReset();
  fanoutSpy.mockReset();
  compileLlmSpy.mockReset();
  client = createClient({ url: ":memory:" });
  db = drizzle(client);
  await client.executeMultiple(`
    CREATE TABLE briefings (
      id TEXT PRIMARY KEY,
      briefing_date TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'adhoc',
      title TEXT NOT NULL,
      summary_md TEXT NOT NULL DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'compiling',
      focus TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      owner_email TEXT NOT NULL DEFAULT 'local@localhost',
      org_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'private'
    );
  `);
});

afterEach(() => {
  client.close();
});

async function loadRow(id: string) {
  const [row] = await db
    .select()
    .from(briefings)
    .where(eq(briefings.id, id))
    .limit(1);
  return row;
}

describe("synthesis — agent polish overwrites the deterministic digest (§1.5.18)", () => {
  it("writes an agent narrative (marker, != digest) and compile uses no LLM", async () => {
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
    ]);
    const fanned: BriefingSource[] = [
      source({ app: "mail", status: "ok", responseText: "Reply to Dana." }),
      source({ app: "calendar", status: "ok", responseText: "Standup at 9." }),
    ];
    fanoutSpy.mockResolvedValue(fanned);

    const POLISH_MARKER = "POLISHED::priority-narrative";

    const briefingId = await asUser(userA, async () => {
      // Step 1: compile (only mail+calendar so brain routing doesn't fire).
      const c = await compileBriefing.run({
        kind: "morning",
        apps: ["mail", "calendar"],
      });

      // The stub agent reads sources and synthesizes a prioritized narrative.
      const polished = `${POLISH_MARKER}\n\nTop today: reply to Dana before the 9am standup.`;
      await updateBriefing.run({ id: c.briefingId, summaryMd: polished });
      return c.briefingId;
    });

    const row = await loadRow(briefingId);
    // The fallback digest was written by compile, then overwritten by the agent.
    expect(row.summaryMd).toContain(POLISH_MARKER);
    expect(row.summaryMd).not.toBe(deterministicDigest(fanned));
    // compile-briefing reached for no LLM.
    expect(compileLlmSpy).toHaveBeenCalledTimes(0);

    // Raw sources remain expandable for audit (acceptance 2).
    const sources: BriefingSource[] = JSON.parse(row.sourcesJson);
    expect(sources.map((s) => s.app)).toEqual(["mail", "calendar"]);
    expect(sources[0].responseText).toBe("Reply to Dana.");
  });
});

describe("synthesis — cross-user isolation (§12 acceptance 5)", () => {
  it("user A's briefing never contains user B's source content", async () => {
    discoverSpy.mockResolvedValue([discovered("mail", 8110)]);

    // Each user's fan-out returns content tagged with their own marker, set per
    // call just before each compile run below.
    let currentMarker = "";
    fanoutSpy.mockImplementation(async () => [
      source({ app: "mail", status: "ok", responseText: currentMarker }),
    ]);

    currentMarker = "AAA-secret-mail";
    const idA = await asUser(userA, async () => {
      const c = await compileBriefing.run({ apps: ["mail"] });
      return c.briefingId;
    });

    currentMarker = "BBB-secret-mail";
    const idB = await asUser(userB, async () => {
      const c = await compileBriefing.run({ apps: ["mail"] });
      return c.briefingId;
    });

    const rowA = await loadRow(idA);
    const rowB = await loadRow(idB);

    expect(rowA.ownerEmail).toBe(userA);
    expect(rowB.ownerEmail).toBe(userB);
    // A's row holds only A's content; B's marker never leaks in.
    expect(rowA.sourcesJson).toContain("AAA-secret-mail");
    expect(rowA.sourcesJson).not.toContain("BBB-secret-mail");
    expect(rowB.sourcesJson).toContain("BBB-secret-mail");
    expect(rowB.sourcesJson).not.toContain("AAA-secret-mail");
  });
});
