#!/usr/bin/env node
// msb-bridge (Form B) — the host-side microsandbox SDK bridge for the
// orchestrator container.
//
// WHY THIS RUNS ON THE HOST, NOT IN THE CONTAINER
// The `microsandbox` npm SDK is a native NAPI addon that bundles `msb` +
// `libkrunfw` and boots the microVM IN-PROCESS via libkrun. libkrun needs
// `/dev/kvm`, which only exists on the WSL2 HOST (DESKTOP-LN6MHG4) — never in the
// `an-orchestrator` Docker container. So the container drives microVMs by calling
// THIS small HTTP service, a plain user process on the host (no sudo, no
// systemd), which uses the SDK directly: `Sandbox.builder(name)…create()`,
// `execStream`, `fs()`, and teardown.
//
// CONTRACT (consumed by `server/runtime/msb-runtime.ts` in the container):
//   POST   /v1/sandbox                       {image,name?,cpus?,memMb?,env?,netRules?} -> {name}
//   POST   /v1/sandbox/:name/exec            {cmd,args?,cwd?,env?,stdin?,timeoutMs?}   -> {code,stdout,stderr}
//   POST   /v1/sandbox/:name/exec-stream     {cmd,args?,cwd?,env?,stdin?,timeoutMs?}   -> SSE (started/stdout/stderr/exited), flushed per frame
//   POST   /v1/sandbox/:name/fs/write        {path, contentB64}                        -> {ok}
//   GET    /v1/sandbox/:name/fs/read?path=…                                            -> {contentB64}
//   POST   /v1/sandbox/:name/copy-from-host  {hostPath, guestPath}                     -> {ok}
//   DELETE /v1/sandbox/:name                                                           -> {removed} (FORCE teardown by name)
//   GET    /v1/health                                                                  -> {ok,msbVersion,sdkVersion,kvm}
//
// REQUIRED MITIGATIONS (the real landmines, baked in here):
//   ① ONE msb version. The SDK bundles its own `msb`/libkrunfw; we report both the
//      SDK version and the host `msb --version` in /v1/health so a drift is
//      visible. The bridge ALWAYS uses the SDK (never shells the host `msb`), so
//      the shared `~/.microsandbox` DB is only ever touched by one msb version.
//   ② Teardown BY NAME — `Sandbox.get(name)` -> handle -> `stopWithTimeout(0)` ->
//      `remove()`. NEVER tear down via the owning `Sandbox` object created by this
//      process (that path throws ECHILD when the VM reparented to PID1). Every
//      provision is `.detached(true)`, so the VM survives this bridge restarting.
//   ③ Reconcile orphans — on startup + on a timer, `Sandbox.list()` and
//      force-remove any `an-node-*` not in the live set this process is tracking.
//   ④ WSL2 fail-loud — KVM/SIGABRT/libkrun errors are surfaced clearly (health
//      reports kvm:false; provision/exec errors carry the SDK message) and trigger
//      a reconcile sweep rather than a silent hang.
//
// SECURITY: bearer auth on every request (ORCH_MSB_BRIDGE_TOKEN). Sandbox names
// are constrained to /^an-node-[a-z0-9-]+$/ so a caller cannot address arbitrary
// host sandboxes. Bind 0.0.0.0 by default so the container reaches it via
// host.docker.internal (host-gateway); restrict with ORCH_MSB_BRIDGE_HOST.

import http from "node:http";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { Sandbox, NetworkPolicy } from "microsandbox";

const PORT = Number(process.env.ORCH_MSB_BRIDGE_PORT || 8730);
const HOST = process.env.ORCH_MSB_BRIDGE_HOST || "0.0.0.0";
const TOKEN = process.env.ORCH_MSB_BRIDGE_TOKEN || "";
const DEFAULT_TIMEOUT_MS = Number(
  process.env.ORCH_MSB_BRIDGE_TIMEOUT_MS || 600_000,
);
const RECONCILE_INTERVAL_MS = Number(
  process.env.ORCH_MSB_RECONCILE_INTERVAL_MS || 60_000,
);
// Only manage sandboxes under this prefix — never touch foreign sandboxes that
// happen to share the host's ~/.microsandbox.
const MANAGED_PREFIX = "an-node-";
const NAME_RE = /^an-node-[a-z0-9-]+$/;

function log(...args) {
  // eslint-disable-next-line no-console
  console.log(`[msb-bridge ${new Date().toISOString()}]`, ...args);
}
function logErr(...args) {
  // eslint-disable-next-line no-console
  console.error(`[msb-bridge ${new Date().toISOString()}]`, ...args);
}

if (!TOKEN) {
  logErr(
    "FATAL: ORCH_MSB_BRIDGE_TOKEN is not set. Refusing to start an unauthenticated bridge.",
  );
  process.exit(1);
}

// The set of sandbox names THIS process created and still considers live. Used
// by the reconciler to distinguish our orphans from in-flight VMs.
const live = new Set();

// ── helpers ──────────────────────────────────────────────────────────────────

function authOk(req) {
  const h = req.headers["authorization"] || "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return false;
  const got = m[1];
  if (got.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++)
    diff |= got.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

function sendJson(res, status, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

/** True iff the host has a usable /dev/kvm (the WSL2 fail-loud signal). */
function kvmPresent() {
  try {
    return existsSync("/dev/kvm");
  } catch {
    return false;
  }
}

/** Best-effort host `msb --version` (diagnostic only; the bridge uses the SDK). */
function hostMsbVersion() {
  return new Promise((resolve) => {
    execFile(
      process.env.ORCH_MSB_BIN || "msb",
      ["--version"],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = /(\d+\.\d+\.\d+)/.exec(String(stdout));
        resolve(m ? m[1] : null);
      },
    );
  });
}

/** The SDK's own version (the version actually booting the VMs). */
async function sdkVersion() {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    return require("microsandbox/package.json").version ?? null;
  } catch {
    // ESM-export-guarded package.json: read it off the resolved module dir.
    try {
      const { readFileSync } = await import("node:fs");
      const { fileURLToPath } = await import("node:url");
      const url = await import.meta.resolve?.("microsandbox");
      if (url) {
        const dir = fileURLToPath(url).replace(/dist\/index\.js$/, "");
        const pkg = JSON.parse(readFileSync(dir + "package.json", "utf8"));
        return pkg.version ?? null;
      }
    } catch {
      /* fall through */
    }
    return null;
  }
}

/** Validate + return the sandbox name from the URL, or throw a 400-ish error. */
function nameFromPath(parts) {
  const name = decodeURIComponent(parts[2] || "");
  if (!NAME_RE.test(name)) {
    const e = new Error(`invalid sandbox name: ${name}`);
    e.statusCode = 400;
    throw e;
  }
  return name;
}

// ── exec-options builder shared by exec + exec-stream ────────────────────────

/**
 * Apply {args,cwd,env,stdin,timeoutMs} onto the SDK's native ExecOptionsBuilder.
 * `stdin` arrives as a base64 string (binary-safe) and is set via stdinBytes.
 */
function configureExec(b, body) {
  if (Array.isArray(body.args) && body.args.length > 0)
    b = b.args(body.args.map(String));
  if (body.cwd) b = b.cwd(String(body.cwd));
  if (body.env && typeof body.env === "object")
    b = b.envs(
      Object.fromEntries(
        Object.entries(body.env).map(([k, v]) => [k, String(v)]),
      ),
    );
  if (typeof body.stdinB64 === "string") {
    b = b.stdinBytes(Buffer.from(body.stdinB64, "base64"));
  } else if (typeof body.stdin === "string") {
    b = b.stdinBytes(Buffer.from(body.stdin, "utf8"));
  }
  const t = Number(body.timeoutMs);
  b = b.timeout(Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS);
  return b;
}

// ── route handlers ───────────────────────────────────────────────────────────

async function handleCreate(req, res) {
  const body = await readJsonBody(req);
  const image = String(body.image || "").trim();
  if (!image) return sendJson(res, 400, { error: "image is required" });
  let name = String(body.name || "").trim();
  if (name) {
    if (!NAME_RE.test(name))
      return sendJson(res, 400, {
        error: `name must match ${NAME_RE} (got "${name}")`,
      });
  } else {
    name = `${MANAGED_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
  }

  if (!kvmPresent()) {
    // WSL2 fail-loud: don't even try to boot — surface the real blocker.
    return sendJson(res, 503, {
      error: "kvm-unavailable",
      detail:
        "/dev/kvm is not present on the host — libkrun cannot boot a microVM. " +
        "Check WSL2 nested virtualization / KVM permissions.",
    });
  }

  try {
    let builder = Sandbox.builder(name)
      .image(image)
      // The worker image is already in msb's cache (prebaked). Never pull on the
      // hot path; "if-missing" lets a first-run host pull once, then cache.
      .pullPolicy("if-missing")
      .cpus(Number(body.cpus) > 0 ? Number(body.cpus) : 1)
      .memory(Number(body.memMb) > 0 ? Number(body.memMb) : 1024)
      // DETACHED so the VM reparents to PID1 and survives this bridge process
      // exiting/restarting (proven on this host). Teardown is always BY NAME.
      .detached(true)
      // Replace a same-named leftover immediately (no SIGTERM wait) so a retried
      // provision never wedges on a stale VM.
      .replaceWithTimeout(0)
      .label("owner", "an-orchestrator")
      .quietLogs();

    if (body.env && typeof body.env === "object") {
      builder = builder.envs(
        Object.fromEntries(
          Object.entries(body.env).map(([k, v]) => [k, String(v)]),
        ),
      );
    }

    // Optional egress policy (netRules). DEFAULT (omitted) = no policy = full NAT
    // egress, which is the proven path on this host: the VM masquerades onto the
    // host subnet and reaches the public internet once DNS is fixed (the runtime
    // layer does that and keeps the host vLLM direct via NO_PROXY). Callers may
    // tighten egress to a domain allow-list with
    //   {netRules:[{action:"allowEgress",domainSuffix:"github.com"}, …]}.
    // Rules go through the SDK's NetworkPolicyBuilder.egress(rule=>…) batch
    // closure + RuleBuilder destination setters, then policyFromBuilder().
    if (Array.isArray(body.netRules) && body.netRules.length > 0) {
      builder = builder.network((n) => {
        const policy = NetworkPolicy.builder().egress((rule) => {
          // `rule` is a RuleBuilder pre-set to Egress; each adder commits a rule.
          for (const r of body.netRules) {
            const deny = r.action === "denyEgress";
            if (r.domainSuffix) {
              deny
                ? rule.denyDomainSuffix(String(r.domainSuffix))
                : rule.allowDomainSuffix(String(r.domainSuffix));
            } else if (r.domain) {
              deny
                ? rule.denyDomain(String(r.domain))
                : rule.allowDomain(String(r.domain));
            } else if (r.cidr) {
              const cidr = String(r.cidr);
              deny
                ? rule.deny((d) => d.cidr(cidr))
                : rule.allow((d) => d.cidr(cidr));
            }
          }
          return rule;
        });
        return n.policyFromBuilder(policy);
      });
    }

    const sb = await builder.create();
    live.add(name);
    // We do NOT keep the `sb` object for lifecycle — teardown is by name. Detach
    // our in-process handle so its GC/dispose never SIGTERMs the detached VM.
    try {
      await sb.detach();
    } catch {
      /* already detached / best-effort */
    }
    log(`created sandbox ${name} (image=${image})`);
    return sendJson(res, 200, { name });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr(`create ${name} failed: ${msg}`);
    // Fail-loud + reconcile so a half-booted VM never leaks.
    void reconcileOnce("create-error");
    return sendJson(res, 500, { error: "create-failed", detail: msg });
  }
}

async function handleExec(req, res, name) {
  const body = await readJsonBody(req);
  const cmd = String(body.cmd || "");
  if (!cmd) return sendJson(res, 400, { error: "cmd is required" });
  try {
    const sb = await connectByName(name);
    const out = await sb.execStreamWith(cmd, (b) => configureExec(b, body));
    const result = await out.collect();
    return sendJson(res, 200, {
      code: result.code,
      stdout: result.stdout(),
      stderr: result.stderr(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr(`exec ${name} failed: ${msg}`);
    return sendJson(res, 500, { error: "exec-failed", detail: msg });
  }
}

async function handleExecStream(req, res, name) {
  const body = await readJsonBody(req);
  const cmd = String(body.cmd || "");
  if (!cmd) return sendJson(res, 400, { error: "cmd is required" });

  // SSE headers — flush-per-frame so the in-container decoder sees output live.
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  res.flushHeaders?.();

  let closed = false;
  const writeEvent = (event, data) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  };

  let handle;
  try {
    const sb = await connectByName(name);
    handle = await sb.execStreamWith(cmd, (b) => configureExec(b, body));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr(`exec-stream ${name} setup failed: ${msg}`);
    writeEvent("error", { message: msg });
    writeEvent("exited", { code: -1 });
    closed = true;
    res.end();
    return;
  }

  // Kill the SDK exec on client disconnect (cancel race) so a runaway in-VM
  // command stops and the VM frees up.
  const onAbort = () => {
    if (closed) return;
    closed = true;
    void handle.kill().catch(() => {});
  };
  req.on("aborted", onAbort);
  res.on("close", () => {
    if (!res.writableEnded) onAbort();
  });

  try {
    // Iterating the handle to completion consumes the `exited` event — the exit
    // code is carried ON that event. We must NOT also call handle.wait()
    // afterwards (the SDK throws "exec session ended without exit event").
    let sawExit = false;
    for await (const ev of handle) {
      if (closed) break;
      if (ev.kind === "started") {
        writeEvent("started", { pid: ev.pid });
      } else if (ev.kind === "stdout") {
        writeEvent("stdout", { b64: Buffer.from(ev.data).toString("base64") });
      } else if (ev.kind === "stderr") {
        writeEvent("stderr", { b64: Buffer.from(ev.data).toString("base64") });
      } else if (ev.kind === "exited") {
        sawExit = true;
        writeEvent("exited", { code: ev.code });
      }
    }
    if (!sawExit && !closed) writeEvent("exited", { code: -1 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!closed) {
      logErr(`exec-stream ${name} iterate failed: ${msg}`);
      writeEvent("error", { message: msg });
      writeEvent("exited", { code: -1 });
    }
  } finally {
    closed = true;
    if (!res.writableEnded) res.end();
  }
}

async function handleFsWrite(req, res, name) {
  const body = await readJsonBody(req);
  const path = String(body.path || "");
  if (!path) return sendJson(res, 400, { error: "path is required" });
  const b64 = typeof body.contentB64 === "string" ? body.contentB64 : "";
  try {
    const sb = await connectByName(name);
    await sb.fs().write(path, Buffer.from(b64, "base64"));
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return sendJson(res, 500, { error: "fs-write-failed", detail: msg });
  }
}

async function handleFsRead(req, res, name, url) {
  const path = url.searchParams.get("path") || "";
  if (!path) return sendJson(res, 400, { error: "path is required" });
  try {
    const sb = await connectByName(name);
    const bytes = await sb.fs().read(path);
    return sendJson(res, 200, {
      contentB64: Buffer.from(bytes).toString("base64"),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return sendJson(res, 500, { error: "fs-read-failed", detail: msg });
  }
}

async function handleCopyFromHost(req, res, name) {
  const body = await readJsonBody(req);
  const hostPath = String(body.hostPath || "");
  const guestPath = String(body.guestPath || "");
  if (!hostPath || !guestPath)
    return sendJson(res, 400, { error: "hostPath and guestPath are required" });
  try {
    const sb = await connectByName(name);
    await sb.fs().copyFromHost(hostPath, guestPath);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return sendJson(res, 500, { error: "copy-from-host-failed", detail: msg });
  }
}

async function handleDelete(req, res, name) {
  try {
    await teardownByName(name);
    live.delete(name);
    log(`force-teardown ${name} ok`);
    return sendJson(res, 200, { removed: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logErr(`teardown ${name} failed: ${msg}`);
    live.delete(name);
    return sendJson(res, 500, { error: "teardown-failed", detail: msg });
  }
}

async function handleHealth(req, res) {
  const [host, sdk] = await Promise.all([hostMsbVersion(), sdkVersion()]);
  const kvm = kvmPresent();
  return sendJson(res, 200, {
    ok: kvm,
    kvm,
    sdkVersion: sdk,
    msbVersion: sdk, // the SDK's bundled msb IS what boots VMs
    hostMsbVersion: host,
    versionMatch: host != null && sdk != null ? host === sdk : null,
    managed: live.size,
  });
}

// ── SDK lifecycle helpers (mitigation ② teardown-by-name) ────────────────────

/**
 * Connect to a running sandbox by name WITHOUT taking lifecycle ownership, so a
 * later GC/dispose of this handle never tears down the detached VM. Used by
 * exec/exec-stream/fs.
 */
async function connectByName(name) {
  const handle = await Sandbox.get(name); // SandboxHandle
  return handle.connect(); // attach without owning lifecycle
}

/** FORCE teardown by name: stopWithTimeout(0) then remove. Never via an owned obj. */
async function teardownByName(name) {
  const handle = await Sandbox.get(name); // throws SandboxNotFound if already gone
  await handle.stopWithTimeout(0); // 0 = SIGKILL immediately, resolves either way
  await handle.remove();
}

// ── reconcile (mitigation ③) ─────────────────────────────────────────────────

/**
 * Force-remove any `an-node-*` sandbox the host knows about that THIS process is
 * not tracking as live. On a fresh bridge start `live` is empty, so this sweeps
 * every orphan an-node-* left by a crashed prior run. Conservative: only touches
 * the managed prefix; never foreign sandboxes.
 */
async function reconcileOnce(reason) {
  try {
    const handles = await Sandbox.list();
    let swept = 0;
    for (const h of handles) {
      const name = h.name;
      if (!name.startsWith(MANAGED_PREFIX)) continue;
      if (live.has(name)) continue;
      try {
        await h.stopWithTimeout(0);
        await h.remove();
        swept++;
        log(`reconcile(${reason}): force-removed orphan ${name}`);
      } catch (e) {
        logErr(
          `reconcile(${reason}): failed to remove ${name}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    if (swept > 0) log(`reconcile(${reason}): swept ${swept} orphan(s)`);
  } catch (e) {
    // WSL2 fail-loud: a list failure usually means a KVM/runtime problem.
    logErr(
      `reconcile(${reason}) error (KVM/runtime?): ${
        e instanceof Error ? e.message : String(e)
      } — kvm=${kvmPresent()}`,
    );
  }
}

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // ["v1","sandbox",name,...]

    if (req.method === "GET" && url.pathname === "/v1/health") {
      if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });
      return handleHealth(req, res);
    }
    if (!authOk(req)) return sendJson(res, 401, { error: "unauthorized" });

    // POST /v1/sandbox
    if (req.method === "POST" && url.pathname === "/v1/sandbox") {
      return handleCreate(req, res);
    }

    if (parts[0] === "v1" && parts[1] === "sandbox" && parts[2]) {
      const name = nameFromPath(parts);
      const sub = parts.slice(3).join("/");
      if (req.method === "POST" && sub === "exec")
        return handleExec(req, res, name);
      if (req.method === "POST" && sub === "exec-stream")
        return handleExecStream(req, res, name);
      if (req.method === "POST" && sub === "fs/write")
        return handleFsWrite(req, res, name);
      if (req.method === "GET" && sub === "fs/read")
        return handleFsRead(req, res, name, url);
      if (req.method === "POST" && sub === "copy-from-host")
        return handleCopyFromHost(req, res, name);
      if (req.method === "DELETE" && sub === "")
        return handleDelete(req, res, name);
    }

    return sendJson(res, 404, { error: "not found", path: url.pathname });
  } catch (e) {
    const status = e?.statusCode || 500;
    return sendJson(res, status, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

const reconcileTimer = setInterval(() => {
  void reconcileOnce("timer");
}, RECONCILE_INTERVAL_MS);
reconcileTimer.unref?.();

server.listen(PORT, HOST, async () => {
  log(`listening on http://${HOST}:${PORT}`);
  const [host, sdk] = await Promise.all([hostMsbVersion(), sdkVersion()]);
  log(
    `versions: sdk=${sdk} hostMsb=${host} match=${
      host != null && sdk != null ? host === sdk : "unknown"
    } kvm=${kvmPresent()}`,
  );
  // Startup reconcile (mitigation ③): sweep orphan an-node-* from prior crashes.
  await reconcileOnce("startup");
});

function shutdown(sig) {
  log(`${sig} — shutting down (detached VMs survive; orphans reconciled on next start)`);
  clearInterval(reconcileTimer);
  server.close(() => process.exit(0));
  // Don't hang forever if a socket is wedged.
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) => {
  logErr("uncaughtException:", e?.stack || e);
});
process.on("unhandledRejection", (e) => {
  logErr("unhandledRejection:", e?.stack || e);
});
