// Base microVM image registry (DESIGN §7.4.8, FRONTEND §9 Images tab).
//
// Images are CLI-PREBAKED (node + pnpm + git + the `claude` CLI + a project
// language runtime) and pinned per node via `runtime.image`. The app NEVER
// builds an image in-app — this registry is READ-ONLY metadata the Settings →
// Images tab renders so the user can see which base image each language/runtime
// node forks from. The list lives as an optional settings override
// (`orchestrator-runtime-images`) defaulting to the static catalog below; a
// future CLI bake step writes real digests/status here.

import { getSetting } from "@agent-native/core/settings";

/** Settings key holding an optional override of the image catalog. */
export const RUNTIME_IMAGES_KEY = "orchestrator-runtime-images";

/** One prebaked base microVM image (DESIGN §7.4.8). */
export interface RuntimeImage {
  /** OCI image ref pinned by `runtime.image`. */
  ref: string;
  /** The language/runtime this image targets (projects have no "kind", §6.1). */
  runtime: string;
  /** Human description of what is prebaked. */
  description: string;
  /** Notable prebaked tools (for the UI badge row). */
  tools: string[];
  /** Whether the bake has produced this image. CLI-driven; default "prebaked". */
  status: "prebaked" | "missing";
  /** The image a node gets when `runtime.image` is unset. */
  default: boolean;
}

/**
 * The static default catalog. The base image carries the fixed toolchain so
 * INIT is fast (§7.4.8: without prebaking every node re-installs claude + deps).
 * `default:true` is the node+pnpm+git+claude base used when a node pins nothing.
 */
const DEFAULT_IMAGES: RuntimeImage[] = [
  {
    ref: "orchestrator/node-base:1",
    runtime: "node",
    description:
      "Base microVM: node 22 + pnpm + git + the claude CLI. Default for every node that pins no image.",
    tools: ["node", "pnpm", "git", "claude"],
    status: "prebaked",
    default: true,
  },
  {
    ref: "orchestrator/python-base:1",
    runtime: "python",
    description:
      "Base + Python 3.12 + uv for Python projects (forked from node-base).",
    tools: ["python", "uv", "git", "claude"],
    status: "prebaked",
    default: false,
  },
  {
    ref: "orchestrator/go-base:1",
    runtime: "go",
    description: "Base + the Go toolchain for Go projects.",
    tools: ["go", "git", "claude"],
    status: "prebaked",
    default: false,
  },
];

/** A short note rendered under the read-only Images list. */
export const IMAGES_NOTE =
  "Images are prebaked by the CLI (§7.4.8). This view is read-only — there is no in-app build.";

/** Validate a single override entry into a RuntimeImage (drops malformed ones). */
function coerceImage(value: unknown): RuntimeImage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.ref !== "string" || v.ref.trim() === "") return null;
  return {
    ref: v.ref,
    runtime: typeof v.runtime === "string" ? v.runtime : "node",
    description: typeof v.description === "string" ? v.description : "",
    tools: Array.isArray(v.tools)
      ? v.tools.filter((t): t is string => typeof t === "string")
      : [],
    status: v.status === "missing" ? "missing" : "prebaked",
    default: v.default === true,
  };
}

/**
 * Read the image catalog: a settings override if present and well-formed, else
 * the static default catalog. A throwing/empty setting degrades to the default.
 */
export async function listRuntimeImages(): Promise<RuntimeImage[]> {
  let raw: unknown = null;
  try {
    raw = await getSetting(RUNTIME_IMAGES_KEY);
  } catch {
    return DEFAULT_IMAGES;
  }
  const arr =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { images?: unknown }).images)
      ? (raw as { images: unknown[] }).images
      : Array.isArray(raw)
        ? (raw as unknown[])
        : null;
  if (!arr) return DEFAULT_IMAGES;
  const coerced = arr
    .map(coerceImage)
    .filter((i): i is RuntimeImage => i != null);
  return coerced.length > 0 ? coerced : DEFAULT_IMAGES;
}
