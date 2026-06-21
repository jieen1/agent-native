/**
 * Phase B2 integration tests for the `compile-briefing` action.
 *
 * Runs the REAL action end-to-end against an in-memory libsql db. OAuth is not
 * required (§1.5.24): `discoverAgents` and `runFanout` are mocked so we exercise
 * the action's orchestration (insert compiling row -> fan out -> write final
 * row) deterministically.
 *
 * Coverage (docs/IMPLEMENTATION_PLAN.md Phase B2 / §1.5.6 / §1.5.18):
 *   - inserts a row, fans out, writes sources + a no-LLM digest summary,
 *   - derives complete / partial / failed from per-source status,
 *   - records a wanted-but-undiscovered app as a `skipped` source,
 *   - forwards selfAppId:"chief-of-staff" into runFanout (§1.5.5),
 *   - scopes the row to the authenticated owner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { briefings } from "../server/db/schema.js";
import { deterministicDigest } from "../shared/digest.js";
import type { BriefingSource } from "../shared/types.js";

const owner = "owner@example.com";

let client: Client;
let db: ReturnType<typeof drizzle>;

vi.mock("../server/db/index.js", async () => ({
  getDb: () => db,
  schema: await vi.importActual("../server/db/schema.js"),
}));

// discoverAgents is mocked per-test below via the shared spy.
const discoverSpy = vi.fn();
vi.mock("@agent-native/core/server/agent-discovery", () => ({
  discoverAgents: (...args: unknown[]) => discoverSpy(...args),
}));

// runFanout is mocked so the action is deterministic without a live A2A net.
const fanoutSpy = vi.fn();
vi.mock("../shared/fanout.js", async () => {
  const actual = await vi.importActual<typeof import("../shared/fanout.js")>(
    "../shared/fanout.js",
  );
  return {
    ...actual,
    runFanout: (...args: unknown[]) => fanoutSpy(...args),
  };
});

// Briefing settings are mocked: default tests run with no stored settings, so
// `enabledApps` falls back to DEFAULT_APPS and there are no prompt overrides.
// Individual tests can override `getSettingSpy` to exercise the settings path.
const getSettingSpy = vi.fn(async () => null as Record<string, unknown> | null);
vi.mock("@agent-native/core/settings", () => ({
  getUserSetting: (...args: unknown[]) => getSettingSpy(...args),
  putUserSetting: vi.fn(async () => undefined),
}));

// Brain second-level routing is mocked: default returns no extra targets, so
// only the first-level fan-out runs. The brain-routing test overrides this.
const routeViaBrainSpy = vi.fn(async () => ({
  targets: [] as Array<{ id: string }>,
  suggestedAppIds: [] as string[],
}));
vi.mock("../shared/brain-routing.js", () => ({
  routeViaBrain: (...args: unknown[]) => routeViaBrainSpy(...args),
}));

const { default: compileBriefing } = await import("./compile-briefing.js");

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
  getSettingSpy.mockReset();
  getSettingSpy.mockResolvedValue(null);
  routeViaBrainSpy.mockReset();
  routeViaBrainSpy.mockResolvedValue({ targets: [], suggestedAppIds: [] });
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

describe("compile-briefing — happy path", () => {
  it("inserts, fans out, and writes sources + digest with status complete", async () => {
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
    ]);
    const fanned: BriefingSource[] = [
      source({ app: "mail", status: "ok", responseText: "Reply to Dana." }),
      source({ app: "calendar", status: "ok", responseText: "Standup at 9." }),
    ];
    fanoutSpy.mockResolvedValue(fanned);

    const res = await asUser(owner, () =>
      compileBriefing.run({ kind: "morning", apps: ["mail", "calendar"] }),
    );

    expect(res.status).toBe("complete");
    expect(res.itemCount).toBe(2);
    expect(res.url).toBe(`/briefings/${res.briefingId}`);

    const row = await loadRow(res.briefingId);
    expect(row.status).toBe("complete");
    expect(row.ownerEmail).toBe(owner);
    expect(row.visibility).toBe("private");
    expect(JSON.parse(row.sourcesJson)).toHaveLength(2);
    expect(row.summaryMd).toBe(deterministicDigest(fanned));
    expect(row.summaryMd).toContain("Reply to Dana.");
  });

  it("passes selfAppId 'chief-of-staff' and the resolved targets into runFanout", async () => {
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
    ]);
    fanoutSpy.mockResolvedValue([source({ app: "mail", status: "ok" })]);

    await asUser(owner, () => compileBriefing.run({ apps: ["mail"] }));

    expect(fanoutSpy).toHaveBeenCalledTimes(1);
    const opts = fanoutSpy.mock.calls[0][0];
    expect(opts.selfAppId).toBe("chief-of-staff");
    expect(opts.targets.map((t: { id: string }) => t.id)).toEqual(["mail"]);
  });

  it("compiles all four default sources into one briefing row (§1.5.16)", async () => {
    // The B3 four-source contract: mail + calendar + brain + analytics all
    // discovered and all `ok` must persist as four sources on the SAME row,
    // status `complete`. No OAuth needed — fan-out is injected (§1.5.24).
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
      discovered("brain", 8112),
      discovered("analytics", 8113),
    ]);
    fanoutSpy.mockImplementation(async (opts: { targets: { id: string }[] }) =>
      opts.targets.map((t) =>
        source({ app: t.id, status: "ok", responseText: `${t.id} ok` }),
      ),
    );
    // Brain's second-level routing returns nothing, so all four come from the
    // single first-level fan-out (not a brain-driven follow-up).
    routeViaBrainSpy.mockResolvedValue({ targets: [], suggestedAppIds: [] });

    const res = await asUser(owner, () =>
      compileBriefing.run({
        kind: "morning",
        apps: ["mail", "calendar", "brain", "analytics"],
      }),
    );

    const row = await loadRow(res.briefingId);
    const sources: BriefingSource[] = JSON.parse(row.sourcesJson);
    const apps = sources.map((s) => s.app).sort();
    expect(apps).toEqual(["analytics", "brain", "calendar", "mail"]);
    expect(sources.every((s) => s.status === "ok")).toBe(true);
    expect(res.status).toBe("complete");
    expect(res.itemCount).toBe(4);
  });

  it("threads kind=evening through to the recap title and prompts", async () => {
    // Phase C §454/§461: an evening recap is the same fan-out with kind=evening;
    // the row title says "Evening recap" and each leg's prompt uses the
    // end-of-day phrasing (verified via the prompt captured by runFanout).
    discoverSpy.mockResolvedValue([discovered("mail", 8110)]);
    fanoutSpy.mockImplementation(
      async (opts: { buildPrompt: (id: string) => string }) => {
        return [
          source({
            app: "mail",
            status: "ok",
            responseText: "x",
            prompt: opts.buildPrompt("mail"),
          }),
        ];
      },
    );

    const res = await asUser(owner, () =>
      compileBriefing.run({ kind: "evening", apps: ["mail"] }),
    );

    const row = await loadRow(res.briefingId);
    expect(row.kind).toBe("evening");
    expect(row.title).toContain("Evening recap");
    const sources: BriefingSource[] = JSON.parse(row.sourcesJson);
    expect(sources[0].prompt).toContain("end-of-day recap");
  });
});

describe("compile-briefing — partial and failed", () => {
  it("derives partial when some sources fail", async () => {
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
    ]);
    fanoutSpy.mockResolvedValue([
      source({ app: "mail", status: "ok", responseText: "x" }),
      source({ app: "calendar", status: "timeout" }),
    ]);

    const res = await asUser(owner, () =>
      compileBriefing.run({ apps: ["mail", "calendar"] }),
    );
    expect(res.status).toBe("partial");
    expect(res.itemCount).toBe(1);
  });

  it("writes status:'partial' when one app errors and the other is ok (§B2)", async () => {
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
    ]);
    // One leg errored (e.g. the sibling agent threw), the other replied.
    fanoutSpy.mockResolvedValue([
      source({ app: "mail", status: "ok", responseText: "Reply to Dana." }),
      source({ app: "calendar", status: "error", error: "calendar down" }),
    ]);

    const res = await asUser(owner, () =>
      compileBriefing.run({ apps: ["mail", "calendar"] }),
    );
    expect(res.status).toBe("partial");
    expect(res.itemCount).toBe(1);

    // The healthy app's data is still persisted alongside the failed one.
    const row = await loadRow(res.briefingId);
    expect(row.status).toBe("partial");
    const sources: BriefingSource[] = JSON.parse(row.sourcesJson);
    const byApp = Object.fromEntries(sources.map((s) => [s.app, s]));
    expect(byApp.mail.status).toBe("ok");
    expect(byApp.mail.responseText).toBe("Reply to Dana.");
    expect(byApp.calendar.status).toBe("error");
    expect(byApp.calendar.error).toBe("calendar down");
  });

  it("derives failed when no source is ok", async () => {
    discoverSpy.mockResolvedValue([discovered("mail", 8110)]);
    fanoutSpy.mockResolvedValue([
      source({ app: "mail", status: "error", error: "down" }),
    ]);

    const res = await asUser(owner, () =>
      compileBriefing.run({ apps: ["mail"] }),
    );
    expect(res.status).toBe("failed");
    expect(res.itemCount).toBe(0);
  });
});

describe("compile-briefing — undiscovered app", () => {
  it("records a wanted-but-undiscovered app as a skipped source", async () => {
    // Only mail is discovered; calendar is wanted but missing.
    discoverSpy.mockResolvedValue([discovered("mail", 8110)]);
    fanoutSpy.mockImplementation(async (opts: { targets: { id: string }[] }) =>
      opts.targets.map((t) =>
        source({ app: t.id, status: "ok", responseText: "ok" }),
      ),
    );

    const res = await asUser(owner, () =>
      compileBriefing.run({ apps: ["mail", "calendar"] }),
    );

    const row = await loadRow(res.briefingId);
    const sources: BriefingSource[] = JSON.parse(row.sourcesJson);
    const calendar = sources.find((s) => s.app === "calendar");
    expect(calendar?.status).toBe("skipped");
    // mail succeeded -> overall partial (one ok, one skipped).
    expect(res.status).toBe("partial");
    // runFanout only ever gets the discovered targets.
    expect(
      fanoutSpy.mock.calls[0][0].targets.map((t: { id: string }) => t.id),
    ).toEqual(["mail"]);
  });
});

describe("compile-briefing — brain second-level fan-out (§6 / §12)", () => {
  it("runs a second fan-out for the apps brain's delegation hints route to", async () => {
    // All four sources discovered. First-level fan-out covers the default set.
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
      discovered("brain", 8112),
      discovered("analytics", 8113),
    ]);

    // First-level fan-out: brain replies, others ok.
    fanoutSpy.mockImplementation(async (opts: { targets: { id: string }[] }) =>
      opts.targets.map((t) =>
        source({ app: t.id, status: "ok", responseText: `${t.id} reply` }),
      ),
    );

    // Brain routing resolves analytics as a second-level target (the §12 case).
    routeViaBrainSpy.mockResolvedValue({
      targets: [discovered("analytics", 8113)],
      suggestedAppIds: ["analytics"],
    });

    const res = await asUser(owner, () =>
      compileBriefing.run({ apps: ["mail", "brain"] }),
    );

    // routeViaBrain was consulted because brain was a first-level target.
    expect(routeViaBrainSpy).toHaveBeenCalledTimes(1);
    const routeArgs = routeViaBrainSpy.mock.calls[0][0] as {
      alreadyWanted: string[];
      selfAppId: string;
    };
    expect(routeArgs.selfAppId).toBe("chief-of-staff");
    expect(routeArgs.alreadyWanted).toEqual(["mail", "brain"]);

    // Two runFanout calls: first-level [mail, brain], second-level [analytics].
    expect(fanoutSpy).toHaveBeenCalledTimes(2);
    expect(
      fanoutSpy.mock.calls[1][0].targets.map((t: { id: string }) => t.id),
    ).toEqual(["analytics"]);

    // The second-level analytics source is merged into the briefing.
    const row = await loadRow(res.briefingId);
    const sources: BriefingSource[] = JSON.parse(row.sourcesJson);
    expect(sources.map((s) => s.app)).toContain("analytics");
  });

  it("does not consult brain routing when brain is not a target", async () => {
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
    ]);
    fanoutSpy.mockResolvedValue([source({ app: "mail", status: "ok" })]);

    await asUser(owner, () =>
      compileBriefing.run({ apps: ["mail", "calendar"] }),
    );
    expect(routeViaBrainSpy).not.toHaveBeenCalled();
  });
});

describe("compile-briefing — settings overrides (Phase B3)", () => {
  it("uses the user's enabledApps when no explicit apps are passed", async () => {
    getSettingSpy.mockResolvedValue({ enabledApps: ["mail"] });
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
    ]);
    fanoutSpy.mockImplementation(async (opts: { targets: { id: string }[] }) =>
      opts.targets.map((t) => source({ app: t.id, status: "ok" })),
    );

    await asUser(owner, () => compileBriefing.run({}));

    // Only mail was wanted (from settings), so calendar is never fanned out.
    expect(
      fanoutSpy.mock.calls[0][0].targets.map((t: { id: string }) => t.id),
    ).toEqual(["mail"]);
  });

  it("drops a disabled app from the fan-out while keeping the others", async () => {
    // User turned analytics off but left mail/calendar/brain on.
    getSettingSpy.mockResolvedValue({
      enabledApps: ["mail", "calendar", "brain"],
    });
    discoverSpy.mockResolvedValue([
      discovered("mail", 8110),
      discovered("calendar", 8111),
      discovered("brain", 8112),
      discovered("analytics", 8113),
    ]);
    fanoutSpy.mockImplementation(async (opts: { targets: { id: string }[] }) =>
      opts.targets.map((t) => source({ app: t.id, status: "ok" })),
    );

    const res = await asUser(owner, () => compileBriefing.run({}));

    // analytics is discovered but disabled, so it never reaches the fan-out and
    // is not even recorded as a skipped source (it was never wanted).
    const firstLevel = fanoutSpy.mock.calls[0][0].targets.map(
      (t: { id: string }) => t.id,
    );
    expect(firstLevel).toEqual(["mail", "calendar", "brain"]);
    expect(firstLevel).not.toContain("analytics");
    const row = await loadRow(res.briefingId);
    const sources: BriefingSource[] = JSON.parse(row.sourcesJson);
    expect(sources.map((s) => s.app)).not.toContain("analytics");
  });

  it("applies a per-app prompt override to the fan-out buildPrompt", async () => {
    getSettingSpy.mockResolvedValue({
      enabledApps: ["mail"],
      promptOverrides: { mail: "Only VIP threads, nothing else." },
    });
    discoverSpy.mockResolvedValue([discovered("mail", 8110)]);
    fanoutSpy.mockResolvedValue([source({ app: "mail", status: "ok" })]);

    await asUser(owner, () => compileBriefing.run({}));

    const buildPrompt = fanoutSpy.mock.calls[0][0].buildPrompt as (
      id: string,
    ) => string;
    expect(buildPrompt("mail")).toBe("Only VIP threads, nothing else.");
  });
});

describe("compile-briefing — auth", () => {
  it("throws without an authenticated user", async () => {
    discoverSpy.mockResolvedValue([]);
    fanoutSpy.mockResolvedValue([]);
    await expect(compileBriefing.run({})).rejects.toThrow(/authenticated/i);
  });
});
