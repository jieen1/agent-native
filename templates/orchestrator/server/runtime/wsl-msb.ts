// The WSL → `msb` bridge (DESIGN spike-microvm.md): the orchestrator Node
// process runs on WINDOWS, but microsandbox / libkrun / KVM only run inside
// WSL2 Ubuntu (the npm `microsandbox` SDK ships no win32 binary — by design).
// So the MicrosandboxRuntime cannot call the SDK in-process on Windows; it
// drives the `msb` CLI by shelling into WSL with a LOGIN shell (`wsl bash -lc`)
// so `~/.local/bin/msb` is on PATH.
//
// Latency note (verified, spike §"Boot latency"): a full `msb run` CLI
// round-trip is ~8.5 s of tooling overhead (the bare microVM boots in ~194 ms).
// That is fine for a node; callers must NOT impose tight timeouts. Default
// timeout here is generous.
//
// Security: every argument is passed as a separate argv entry to `wsl` and the
// `msb …` string handed to `bash -lc` is built from single-quote-escaped tokens
// (`shArg`), so values containing spaces, quotes, `$`, `;`, backticks, etc.
// cannot break out of the intended command. No user value is interpolated
// unescaped into the shell.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ExecResult, SpawnHandle } from "./node-runtime.js";

/** Where the `wsl.exe` binary lives on Windows (PATH-resolved by default). */
const WSL_BIN = process.env.ORCHESTRATOR_WSL_BIN ?? "wsl";

/** A generous default; an `msb run` round-trip is ~8.5 s (spike). */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Single-quote a token for safe use inside a POSIX `sh`/`bash -c` string. The
 * only character that cannot appear literally inside single quotes is the
 * single quote itself, which we close-escape-reopen via `'\''`. This makes any
 * value (spaces, `$`, `;`, backticks, newlines) inert.
 */
export function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Options for {@link wslMsb}. */
export interface WslMsbOptions {
  /** Max wall-clock before the child is killed. Default 120 s (CLI is slow). */
  timeoutMs?: number;
  /** Text piped to the child's stdin (e.g. file content for `fs.write`). */
  stdin?: string;
}

/**
 * Run `msb <args>` inside WSL via a login shell and capture the result.
 *
 * `args` is an already-tokenized argv for `msb` (each element becomes one
 * single-quote-escaped shell token), e.g.
 *   wslMsb(["run", "-d", "-n", name, "alpine"])
 *   wslMsb(["exec", name, "--", "sh", "-lc", userCmd])
 *
 * Returns the exit code + captured stdout/stderr. A non-zero `code` is RETURNED,
 * never thrown — callers decide what a non-zero exit means (DESIGN §7.1).
 * `wslMsb` only throws if the `wsl` process itself cannot be spawned or times
 * out, which are infrastructure faults, not command failures.
 */
export function wslMsb(
  args: readonly string[],
  opts: WslMsbOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Build the bash -lc payload: `msb 'arg1' 'arg2' …`.
  const msbLine = ["msb", ...args.map(shArg)].join(" ");

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(WSL_BIN, ["bash", "-lc", msbLine], {
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `wslMsb timed out after ${timeoutMs}ms running: msb ${args.join(" ")}`,
        ),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `failed to spawn wsl/msb (${WSL_BIN}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Streamed variant of {@link wslMsb} for long-running `msb exec` commands
 * (backs `NodeRuntime.spawn` → claude `--output-format stream-json`). Spawns
 * `wsl bash -lc "msb …"` and surfaces stdout/stderr as async-iterable text
 * chunks plus a `wait()` for the exit code, matching the {@link SpawnHandle}
 * contract. Backpressure-free buffering: chunks are queued and a waiting
 * consumer is resumed when one arrives.
 */
export function wslMsbStream(args: readonly string[]): SpawnHandle {
  const msbLine = ["msb", ...args.map(shArg)].join(" ");
  const child: ChildProcessWithoutNullStreams = spawn(
    WSL_BIN,
    ["bash", "-lc", msbLine],
    { windowsHide: true },
  );
  child.stdin.end();

  const stdout = streamToAsyncIterable(child.stdout);
  const stderr = streamToAsyncIterable(child.stderr);

  let exitResolve: ((code: number) => void) | null = null;
  let exitCode: number | null = null;
  let exitErr: Error | null = null;
  const waitPromise = new Promise<number>((resolve, reject) => {
    exitResolve = resolve;
    child.on("error", (err: unknown) => {
      exitErr = err instanceof Error ? err : new Error(String(err));
      reject(exitErr);
    });
    child.on("close", (code: number | null) => {
      exitCode = code ?? -1;
      resolve(exitCode);
    });
  });
  // Avoid an unhandled-rejection if no one calls wait() before an error fires.
  waitPromise.catch(() => {});

  return {
    stdout,
    stderr,
    wait: () => {
      if (exitErr) return Promise.reject(exitErr);
      if (exitCode !== null) return Promise.resolve(exitCode);
      return waitPromise;
    },
    kill: () => {
      if (exitCode === null) child.kill("SIGTERM");
      void exitResolve;
    },
  };
}

/**
 * Turn a Node readable stream of bytes into an async iterable of decoded UTF-8
 * text chunks. The stream's own async-iterator handles backpressure and
 * end-of-stream; we only decode each Buffer to a string.
 */
async function* streamToAsyncIterable(
  stream: NodeJS.ReadableStream,
): AsyncIterable<string> {
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    yield typeof chunk === "string" ? chunk : String(chunk);
  }
}

/** True if `wsl` + `msb` are reachable (used to gate the real smoke test). */
export async function msbAvailable(): Promise<boolean> {
  try {
    const res = await wslMsb(["--version"], { timeoutMs: 30_000 });
    return res.code === 0 && /msb\s+\d+\.\d+/.test(res.stdout);
  } catch {
    return false;
  }
}
