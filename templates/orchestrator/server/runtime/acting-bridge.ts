// The model-agnostic acting bridge (DESIGN §7.4.1a). This is the load-bearing
// primitive that lets an engine-model node (vLLM / cloud) do real code work
// INSIDE its microVM, on any model.
//
// `createCodingToolRegistry` ("@agent-native/core/coding-tools") returns the
// canonical `{ bash, read, edit, write }` tool registry — but its built-in
// `run` bodies spawn on the HOST (`runCodingCommand`, local `fs`, local
// `process.env`). For a microVM node we keep the EXACT tool CONTRACT the model
// sees (the four `ActionEntry` `tool` schemas: same names, same `parameters`,
// same descriptions) but REIMPLEMENT the side effects against the VM:
//
//   bash  → runtime.exec(vm, cmd, { cwd })
//   read  → runtime.fs(vm).read(path)
//   write → runtime.fs(vm).write(path, content)
//   edit  → read + exact string-replace + write
//
// The agent loop itself runs on the HOST (the scheduler process); only these
// tool SIDE EFFECTS cross into the VM. This is the §7.4.1a "re-point =
// reimplement, not configure" rule: we never hand the host-spawning impl a
// `cwd` and hope for isolation — the implementations below talk to the VM
// runtime directly.
//
// The returned registry is a `Record<"bash"|"read"|"edit"|"write", ActionEntry>`,
// identical in shape to `createCodingToolRegistry`, so it drops straight into
// `actionsToEngineTools(...)` + `runAgentLoop({ tools, actions })`.

import type { ActionEntry } from "@agent-native/core/server";

import type { NodeRuntime, VmHandle } from "./node-runtime.js";

/** Options for {@link createVmActingBridge}. */
export interface VmActingBridgeOptions {
  /** The runtime backend that owns the VM (exec/fs side effects go here). */
  runtime: NodeRuntime;
  /** The provisioned VM handle every tool acts against. */
  vm: VmHandle;
  /**
   * The in-VM working directory tools resolve relative paths against and bash
   * runs in. This is the node's worktree (e.g. `/work`). Absolute paths in tool
   * args are honored as-is; relative paths are resolved under `workdir`.
   */
  workdir: string;
  /** Per-bash-command timeout (ms). Default 120 000 (matches coding-tools). */
  commandTimeoutMs?: number;
  /** Truncate any tool result to at most this many chars. Default 50 000. */
  maxResultChars?: number;
}

/** A single edit op (mirrors coding-tools' `edits` array element). */
interface EditOp {
  oldText: string;
  newText: string;
  replaceAll?: boolean | string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_RESULT_CHARS = 50_000;

/** Coerce a tool arg to a trimmed string (the model may send numbers/bools). */
function stringArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

/** Truthy "true" flag the way the coding-tools schema encodes booleans. */
function isTrueFlag(value: unknown): boolean {
  return stringArg(value).toLowerCase() === "true";
}

/** Truncate a result string, marking the elision (never throws). */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

/**
 * Resolve a tool path against the VM workdir. Absolute paths (`/…`) pass
 * through; relative paths are joined under `workdir` with POSIX semantics (the
 * VM is Linux). We do NOT use Node's `path` here because that would apply
 * win32 rules on a Windows host — the target is always a POSIX path in the VM.
 */
function resolveVmPath(workdir: string, requested: string): string {
  const p = requested.trim();
  if (p === "") return workdir;
  if (p.startsWith("/")) return p;
  const base = workdir.endsWith("/") ? workdir.slice(0, -1) : workdir;
  return `${base}/${p}`;
}

/** Format a bash {@link import("./node-runtime.js").ExecResult} for the model. */
function formatBashResult(
  code: number,
  stdout: string,
  stderr: string,
): string {
  const parts: string[] = [];
  if (stdout.trim() !== "") parts.push(stdout.replace(/\s+$/, ""));
  if (stderr.trim() !== "")
    parts.push(`[stderr]\n${stderr.replace(/\s+$/, "")}`);
  if (code !== 0) parts.push(`[exit code: ${code}]`);
  const body = parts.join("\n");
  return body === "" ? "(no output)" : body;
}

/** Apply one exact-string-replace edit to `content`, or throw a model-facing error. */
function applyOneEdit(content: string, op: EditOp, filePath: string): string {
  const oldText = stringArg(op.oldText);
  const newText = stringArg(op.newText);
  const replaceAll = op.replaceAll === true || op.replaceAll === "true";
  if (oldText === "") {
    throw new Error(
      `edit ${filePath}: oldText is required and cannot be empty`,
    );
  }
  if (replaceAll) {
    if (!content.includes(oldText)) {
      throw new Error(`edit ${filePath}: oldText not found`);
    }
    return content.split(oldText).join(newText);
  }
  const first = content.indexOf(oldText);
  if (first === -1) throw new Error(`edit ${filePath}: oldText not found`);
  const second = content.indexOf(oldText, first + oldText.length);
  if (second !== -1) {
    throw new Error(
      `edit ${filePath}: oldText matched more than once — add surrounding ` +
        `context to make it unique, or set replaceAll`,
    );
  }
  return (
    content.slice(0, first) + newText + content.slice(first + oldText.length)
  );
}

/** Parse the `edits` arg (a JSON array) into normalized {@link EditOp}s. */
function parseEditsArray(raw: unknown): EditOp[] | null {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr)) return null;
  return arr.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>;
    return {
      oldText: stringArg(o.oldText),
      newText: stringArg(o.newText),
      replaceAll: o.replaceAll as boolean | string | undefined,
    };
  });
}

/**
 * Build the VM-bound `{ bash, read, edit, write }` tool registry (DESIGN
 * §7.4.1a). Each entry's `tool` schema mirrors `createCodingToolRegistry`'s so
 * the model sees an identical contract; each `run` reimplements the side effect
 * against `runtime`/`vm` instead of the host.
 */
export function createVmActingBridge(
  options: VmActingBridgeOptions,
): Record<"bash" | "read" | "edit" | "write", ActionEntry> {
  const { runtime, vm, workdir } = options;
  const commandTimeoutMs =
    options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxResultChars = options.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const fs = runtime.fs(vm);

  const bash: ActionEntry = {
    tool: {
      description:
        "Run a shell command inside the workspace. Use it for file " +
        "discovery (`ls`, `rg --files`, `rg <pattern>`), running tests and " +
        "builds, package scripts, `git status`/`git diff`, and project CLIs. " +
        "Use the read tool to view a single file's contents; use bash for " +
        "everything else. Very long output is truncated.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The shell command to run (executed via the VM shell).",
          },
          cwd: {
            type: "string",
            description:
              "Working directory for the command. Relative to the workspace " +
              "root unless an absolute path is given. Defaults to the " +
              "workspace root.",
          },
          timeoutMs: {
            type: "string",
            description:
              "Timeout in milliseconds; the command is killed if it exceeds " +
              "this. Defaults to 120000, capped at 600000.",
          },
        },
        required: ["command"],
      },
    },
    run: async (args: Record<string, unknown>): Promise<string> => {
      const command = stringArg(args.command);
      if (command === "") return "Error: command is required.";
      const cwd = resolveVmPath(workdir, stringArg(args.cwd) || ".");
      const requested = Number(args.timeoutMs);
      const timeoutMs =
        Number.isFinite(requested) && requested > 0
          ? Math.min(requested, MAX_COMMAND_TIMEOUT_MS)
          : commandTimeoutMs;
      const res = await runtime.exec(vm, command, { cwd, timeoutMs });
      return truncate(
        formatBashResult(res.code, res.stdout, res.stderr),
        maxResultChars,
      );
    },
  };

  const read: ActionEntry = {
    tool: {
      description:
        "Read a single UTF-8 text file, returned with 1-based line numbers. " +
        "Read a file before editing it so your edit's oldText matches " +
        "exactly. Use bash (`ls`, `rg --files`, `rg`) for directory listings, " +
        "file discovery, and search; this tool reads one file only.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Path to the file to read, relative to the workspace root " +
              "unless an absolute path is given.",
          },
          offset: {
            type: "string",
            description:
              "1-based line number to start reading from. Defaults to the " +
              "first line.",
          },
          limit: {
            type: "string",
            description:
              "Maximum number of lines to read from offset. Defaults to the " +
              "rest of the file.",
          },
        },
        required: ["filePath"],
      },
    },
    run: async (args: Record<string, unknown>): Promise<string> => {
      const requested = stringArg(args.filePath);
      if (requested === "") return "Error: filePath is required.";
      const filePath = resolveVmPath(workdir, requested);
      let content: string;
      try {
        content = await fs.read(filePath);
      } catch (err: unknown) {
        return `Error reading ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      const lines = content.split("\n");
      const offset = Number(args.offset);
      const limit = Number(args.limit);
      const start =
        Number.isFinite(offset) && offset >= 1 ? Math.floor(offset) - 1 : 0;
      const end =
        Number.isFinite(limit) && limit > 0
          ? start + Math.floor(limit)
          : lines.length;
      const numbered = lines
        .slice(start, end)
        .map((line, i) => `${start + i + 1}\t${line}`)
        .join("\n");
      return truncate(numbered, maxResultChars);
    },
  };

  const edit: ActionEntry = {
    tool: {
      description:
        "Edit an existing UTF-8 text file by replacing exact text. Prefer " +
        "this over write for changes to existing files. Read the file first " +
        "so oldText matches byte-for-byte, including whitespace and " +
        "indentation. oldText must occur EXACTLY ONCE in the file unless " +
        "replaceAll is true. To apply several edits in one call, pass edits " +
        "as a JSON array of {oldText, newText, replaceAll}; they apply in " +
        "order and any failure aborts the whole call.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Path to the file to edit, relative to the workspace root " +
              "unless an absolute path is given.",
          },
          oldText: {
            type: "string",
            description:
              "Exact existing text to replace, for a single edit. Must match " +
              "the file exactly and uniquely unless replaceAll is true.",
          },
          newText: {
            type: "string",
            description: "Text to replace oldText with, for a single edit.",
          },
          replaceAll: {
            type: "string",
            description:
              'Set to "true" to replace every occurrence of oldText instead ' +
              'of requiring a unique match. Defaults to "false".',
            enum: ["true", "false"],
          },
          edits: {
            type: "string",
            description:
              "JSON array of edits to apply to this file in one call, e.g. " +
              '[{"oldText":"foo","newText":"bar"}]. When provided, the ' +
              "top-level oldText/newText are ignored.",
          },
        },
        required: ["filePath"],
      },
    },
    run: async (args: Record<string, unknown>): Promise<string> => {
      const requested = stringArg(args.filePath);
      if (requested === "") return "Error: filePath is required.";
      const filePath = resolveVmPath(workdir, requested);
      let content: string;
      try {
        content = await fs.read(filePath);
      } catch (err: unknown) {
        return `Error: cannot edit ${filePath} (read failed): ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      const ops =
        parseEditsArray(args.edits) ??
        ([
          {
            oldText: stringArg(args.oldText),
            newText: stringArg(args.newText),
            replaceAll: args.replaceAll as boolean | string | undefined,
          },
        ] as EditOp[]);
      let next = content;
      try {
        for (const op of ops) next = applyOneEdit(next, op, filePath);
      } catch (err: unknown) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      try {
        await fs.write(filePath, next);
      } catch (err: unknown) {
        return `Error: cannot write ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      return `Edited ${filePath} (${ops.length} replacement${
        ops.length === 1 ? "" : "s"
      }).`;
    },
  };

  const write: ActionEntry = {
    tool: {
      description:
        "Create a new UTF-8 text file, or fully overwrite an existing one " +
        "with the given content. Missing parent directories are created. For " +
        "changes to an existing file, prefer edit; only use write when you " +
        "intend to replace the entire file.",
      parameters: {
        type: "object",
        properties: {
          filePath: {
            type: "string",
            description:
              "Path to the file to write, relative to the workspace root " +
              "unless an absolute path is given.",
          },
          content: {
            type: "string",
            description:
              "Full contents to write. This replaces the entire file; " +
              "existing content is not preserved.",
          },
        },
        required: ["filePath", "content"],
      },
    },
    run: async (args: Record<string, unknown>): Promise<string> => {
      const requested = stringArg(args.filePath);
      if (requested === "") return "Error: filePath is required.";
      const filePath = resolveVmPath(workdir, requested);
      const content = stringArg(args.content);
      // Ensure parent dirs exist (write semantics: create missing dirs). The
      // VM is POSIX, so `dirname` is the path up to the last slash.
      const slash = filePath.lastIndexOf("/");
      if (slash > 0) {
        const dir = filePath.slice(0, slash);
        const mk = await runtime.exec(vm, `mkdir -p ${shSingleQuote(dir)}`);
        if (mk.code !== 0) {
          return `Error: cannot create parent dir ${dir}: ${mk.stderr}`;
        }
      }
      try {
        await fs.write(filePath, content);
      } catch (err: unknown) {
        return `Error: cannot write ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      const lineCount = content === "" ? 0 : content.split("\n").length;
      return `Wrote ${filePath} (${lineCount} line${
        lineCount === 1 ? "" : "s"
      }).`;
    },
  };

  void isTrueFlag; // reserved for future bash background flag (P2c)
  return { bash, read, edit, write };
}

/** Single-quote a value for safe interpolation into the VM shell (mkdir -p). */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
