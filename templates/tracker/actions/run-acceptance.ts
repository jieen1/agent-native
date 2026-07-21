import { defineAction } from "@agent-native/core";
import { loadActionsFromStaticRegistry } from "@agent-native/core/server";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import actionsRegistry from "../.generated/actions-registry.js";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import {
  contentDocumentUrl,
  createContentDocument,
  uploadContentImage,
} from "../server/lib/content-client.js";
import { captureScreenshot } from "../server/lib/screenshot.js";

// Lazily materialize the static action registry INSIDE run(), never at module
// top level: actions-registry.js imports every action (including this one), so
// touching it during this module's evaluation hits a circular-import temporal
// dead zone ("Cannot access '<registry>' before initialization") that crashes
// the whole tracker server on boot. By the time run() executes, the registry
// module has finished initializing.
let _localActionRegistry: ReturnType<
  typeof loadActionsFromStaticRegistry
> | null = null;
function getLocalActionRegistry(): ReturnType<
  typeof loadActionsFromStaticRegistry
> {
  if (!_localActionRegistry) {
    _localActionRegistry = loadActionsFromStaticRegistry(actionsRegistry);
  }
  return _localActionRegistry;
}

// Recursive partial-match helper: every key present in `expect` must exist in
// `actual` with an equal value. Objects/arrays are compared recursively;
// basic types use `===`.
function partialMatch(actual: unknown, expect: unknown): boolean {
  if (actual === null || actual === undefined) {
    return expect === actual;
  }
  if (typeof expect !== "object" || expect === null) {
    return actual === expect;
  }
  const expectObj = expect as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;
  for (const key of Object.keys(expectObj)) {
    if (!(key in actualObj)) return false;
    if (!partialMatch(actualObj[key], expectObj[key])) return false;
  }
  return true;
}

export default defineAction({
  description:
    "Run an acceptance check for a work item: execute a list of scenarios " +
    "(action or http), generate a markdown evidence report archived to the " +
    "content app, trigger + complete the 验收 stage, and record an artifact.",
  schema: z.object({
    workItemId: z.string().min(1),
    scenarios: z
      .array(
        z.object({
          name: z.string().min(1),
          kind: z.enum(["action", "http", "screenshot"]),
          action: z
            .string()
            .optional()
            .describe(
              "kind=action 时:本 app 的 action 文件名(不含 .ts),如 complete-stage",
            ),
          args: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("kind=action 时传给该 action 的参数"),
          url: z
            .string()
            .optional()
            .describe(
              "kind=http 时的请求 URL；kind=screenshot 时为要截图的页面 URL",
            ),
          method: z
            .string()
            .optional()
            .describe("kind=http 时的 HTTP method,默认 GET"),
          headers: z.record(z.string(), z.string()).optional(),
          body: z
            .record(z.string(), z.unknown())
            .optional()
            .describe("kind=http 时的请求体,会 JSON.stringify"),
          expect: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              "期望的返回值/响应,部分匹配；kind=screenshot 时可选 { text: string } 表示页面应包含的文本，用于同时做断言",
            ),
        }),
      )
      .min(1),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const now = new Date().toISOString();

    // --- Authenticate and authorize ---
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, args.workItemId),
            ownerScope(schema.workItems),
          ),
        )
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    const itemKey = item.itemKey ?? args.workItemId;

    // --- Execute scenarios sequentially ---
    interface ScenarioResult {
      name: string;
      kind: "action" | "http" | "screenshot";
      expect: Record<string, unknown> | undefined;
      actual: Record<string, unknown>;
      pass: boolean;
    }

    const results: ScenarioResult[] = [];

    for (const sc of args.scenarios) {
      let actual: Record<string, unknown> = {};

      if (sc.kind === "action") {
        // Validate action name format
        if (!sc.action || !/^[a-z0-9-]+$/.test(sc.action)) {
          actual = {
            error: `Invalid action name: ${sc.action ?? "(missing)"}`,
          };
        } else {
          try {
            const entry = getLocalActionRegistry()[sc.action];
            if (!entry) {
              actual = { error: `Unknown action: ${sc.action}` };
            } else {
              actual = (await entry.run(sc.args ?? {})) as Record<
                string,
                unknown
              >;
            }
          } catch (e) {
            actual = { error: String(e) };
          }
        }
      } else if (sc.kind === "http") {
        if (!sc.url) {
          actual = { error: "Missing URL for http scenario" };
        } else {
          try {
            const res = await fetch(sc.url, {
              method: sc.method || "GET",
              headers: sc.headers,
              body: sc.body ? JSON.stringify(sc.body) : undefined,
            });
            const text = await res.text();
            let body: unknown = text;
            try {
              body = JSON.parse(text);
            } catch {
              // keep as string
            }
            actual = { status: res.status, body };
          } catch (e) {
            actual = { error: String(e) };
          }
        }
      } else if (sc.kind === "screenshot") {
        if (!sc.url) {
          actual = { error: "Missing URL for screenshot scenario" };
        } else {
          try {
            const { png, pageText } = await captureScreenshot(sc.url);
            const safeName = sc.name
              .replace(/[^a-zA-Z0-9-_]/g, "_")
              .slice(0, 60);
            const filename = `acceptance-${itemKey}-${safeName}-${Date.now()}.png`;
            const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
            const uploaded = await uploadContentImage(ownerEmail, {
              data: dataUrl,
              filename,
            });
            const expectText =
              sc.expect && typeof sc.expect.text === "string"
                ? (sc.expect.text as string)
                : undefined;
            actual = {
              screenshotUrl: uploaded.url,
              ...(expectText !== undefined
                ? { textFound: pageText.includes(expectText) }
                : {}),
            };
          } catch (e) {
            actual = { error: String(e) };
          }
        }
      }

      const pass =
        sc.kind === "screenshot"
          ? !("error" in actual) &&
            (!("textFound" in actual) || actual.textFound === true)
          : !("error" in actual) && partialMatch(actual, sc.expect ?? {});

      results.push({
        name: sc.name,
        kind: sc.kind,
        expect: sc.expect,
        actual,
        pass,
      });
    }

    // --- Compute verdict ---
    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;
    const verdictResult: "pass" | "reject" = failed === 0 ? "pass" : "reject";

    // --- Generate markdown evidence document ---
    const markdown = [
      `# 验收报告 - ${itemKey}`,
      "",
      `工作项:${args.workItemId} (${itemKey})`,
      `生成时间:${now}`,
      `结论:${passed}/${results.length} 通过 — ${verdictResult === "pass" ? "通过" : "驳回"}`,
      "",
      "## 场景明细",
      "",
      ...results.flatMap((r, i) => [
        `### ${i + 1}. ${r.name} — ${r.pass ? "PASS" : "FAIL"}`,
        "",
        `- kind: ${r.kind}`,
        ...(r.kind === "screenshot" &&
        typeof (r.actual as Record<string, unknown>).screenshotUrl === "string"
          ? [
              "",
              `![${r.name}](${(r.actual as Record<string, unknown>).screenshotUrl})`,
            ]
          : []),
        "",
        "- 预期:",
        "```json",
        JSON.stringify(r.expect, null, 2),
        "```",
        "- 实际:",
        "```json",
        JSON.stringify(r.actual, null, 2),
        "```",
        "",
      ]),
    ].join("\n");

    const title = `验收-${item.itemKey}-${now.replace(/[:.]/g, "-")}`;

    // --- Archive to content app ---
    let contentDoc: Awaited<ReturnType<typeof createContentDocument>>;
    try {
      contentDoc = await createContentDocument(ownerEmail, {
        title,
        content: markdown,
      });
    } catch (e) {
      throw new Error(
        `Failed to archive evidence to content app: ${String(e)}`,
      );
    }

    const evidenceDocUrl = contentDocumentUrl(
      contentDoc.urlPath,
      contentDoc.id,
    );

    // --- Trigger + complete the 验收 stage ---
    const triggerStageAction = await import("./trigger-stage.js");
    await triggerStageAction.default.run({
      workItemId: args.workItemId,
      stageName: "验收",
    });

    const completeStageAction = await import("./complete-stage.js");
    const completeResult = await completeStageAction.default.run({
      workItemId: args.workItemId,
      stageName: "验收",
      verdict: {
        result: verdictResult,
        passed,
        failed,
        total: results.length,
        evidenceDocUrl,
        scenarios: results,
      },
      deliveryItems: [evidenceDocUrl],
    });

    const stageId =
      (completeResult as Record<string, unknown>)?.stageId ?? null;

    // --- Optionally create an artifact record (non-fatal) ---
    try {
      const createArtifactAction = await import("./create-artifact.js");
      await createArtifactAction.default.run({
        workItemId: args.workItemId,
        stageId: String(stageId),
        stageName: "验收",
        kind: "验收报告",
        name: title,
        contentRef: evidenceDocUrl,
        producedByKind: "agent" as const,
      });
    } catch {
      // Non-fatal — do not propagate
    }

    // --- Insert acceptance activity record ---
    await db.insert(schema.activities).values({
      id: `act_acc_${args.workItemId.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
      workItemId: args.workItemId,
      actorKind: "agent",
      actorName: ownerEmail,
      eventType: "验收",
      payload: JSON.stringify({
        verdict: verdictResult,
        passed,
        failed,
        evidenceDocUrl,
      }),
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return {
      verdict: verdictResult,
      passed,
      failed,
      evidenceDocUrl,
      scenarios: results,
    };
  },
});
