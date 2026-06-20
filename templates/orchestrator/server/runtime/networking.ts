// VM public-egress wiring (DESIGN §7.4.9). A node's microVM needs OUTBOUND
// network for: the in-VM `claude` (Anthropic API), `git push` / `gh`, and
// `apk`/`npm` toolchain installs — while a vLLM node still reaches the HOST vLLM
// at localhost:8000 directly (NO proxy, §7.4.9 "In-VM → host vLLM").
//
// Two egress facts established by a real probe on this host (2026-06-21):
//   1. microsandbox masquerades the VM subnet (`172.16.0.0/12`) so the VM has
//      DIRECT NAT egress to the public internet — once DNS works. The VM's
//      built-in resolver (its gateway:53) was timing out, so we OVERRIDE
//      `/etc/resolv.conf` with a public resolver; then `https://api.anthropic.com`
//      is reachable (real 401) and `https://api.github.com/zen` returns a quote.
//   2. A host forward-proxy (`tinyproxy` on the WSL host, :8888) is the
//      ALTERNATE egress path the lead provisioned: a VM reaches it at
//      `http://<vm-default-gateway>:8888`. It is a HOST PREREQUISITE (we never
//      install it from app code). On some boots the gateway:8888 is not
//      reachable from inside the VM, in which case proxy env would BREAK egress —
//      so we PREFLIGHT it from inside the VM and only export proxy env when a
//      real request through it succeeds. Direct NAT egress is the baseline.
//
// This module is pure helpers over a `NodeRuntime` + `VmHandle`; it never bakes a
// secret and never assumes the proxy is up.

import type { NodeRuntime, VmHandle } from "./node-runtime.js";

/** Public DNS resolvers written to the VM's resolv.conf (its own was dead). */
export const FALLBACK_DNS = ["1.1.1.1", "8.8.8.8"];

/** The host forward-proxy port (tinyproxy on the WSL host, §7.4.9). */
export const HOST_PROXY_PORT = 8888;

/** A test URL that proves real public egress (returns a short body). */
const EGRESS_PROBE_URL = "https://api.github.com/zen";

/** The resolved egress configuration for one VM boot. */
export interface VmEgress {
  /** The VM's default-route gateway IP (per boot), or null if undetectable. */
  gateway: string | null;
  /** Whether DIRECT NAT egress to the public internet works (after DNS fix). */
  directEgress: boolean;
  /** The reachable forward-proxy URL (`http://<gw>:<port>`), or null. */
  proxyUrl: string | null;
  /** The env map to merge into every in-VM exec/spawn for this VM. */
  env: Record<string, string>;
}

/** Extract the default-route gateway IP from `ip route` output. */
export function parseGateway(ipRouteStdout: string): string | null {
  for (const line of ipRouteStdout.split(/\r?\n/)) {
    const m = /^default\s+via\s+(\d+\.\d+\.\d+\.\d+)\b/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

/**
 * Build the NO_PROXY list so the host vLLM endpoint (and loopback) stay DIRECT
 * even when a forward-proxy is in use (§7.4.9). `vllmHost` is the host the vLLM
 * baseUrl resolves to as seen from the VM; we keep localhost variants too.
 */
export function buildNoProxy(extraHosts: string[] = []): string {
  const base = ["localhost", "127.0.0.1", "::1"];
  const all = [...base, ...extraHosts.filter((h) => h && h.trim() !== "")];
  return Array.from(new Set(all)).join(",");
}

/**
 * Write a working `/etc/resolv.conf` into the VM (its own resolver was dead) so
 * direct NAT egress can resolve names. Idempotent; best-effort (a failure is
 * reported via the returned code, not thrown — the caller decides).
 */
export async function fixVmDns(
  runtime: NodeRuntime,
  vm: VmHandle,
): Promise<boolean> {
  const body = FALLBACK_DNS.map((ns) => `nameserver ${ns}`).join("\n");
  const res = await runtime.exec(
    vm,
    `printf '%s\\n' ${shSingle(body)} > /etc/resolv.conf`,
  );
  return res.code === 0;
}

/**
 * Probe DIRECT public egress from inside the VM (no proxy). Returns true when a
 * real HTTPS request to the public internet succeeds. Uses curl if present, else
 * wget; tolerates either being absent (returns false).
 */
export async function probeDirectEgress(
  runtime: NodeRuntime,
  vm: VmHandle,
): Promise<boolean> {
  const cmd =
    `if command -v curl >/dev/null 2>&1; then ` +
    `curl -fsS --max-time 12 ${shSingle(EGRESS_PROBE_URL)} >/dev/null 2>&1; ` +
    `elif command -v wget >/dev/null 2>&1; then ` +
    `wget -q -T 12 -O /dev/null ${shSingle(EGRESS_PROBE_URL)} >/dev/null 2>&1; ` +
    `else exit 3; fi`;
  const res = await runtime.exec(vm, cmd, { timeoutMs: 20_000 });
  return res.code === 0;
}

/**
 * Probe the host forward-proxy from inside the VM. Returns the proxy URL when a
 * real request THROUGH it succeeds, else null. We never trust the proxy blindly:
 * on a boot where `gateway:8888` is refused, exporting proxy env would break
 * egress, so this gate keeps proxy env off unless it actually works.
 */
export async function probeProxy(
  runtime: NodeRuntime,
  vm: VmHandle,
  gateway: string | null,
  port: number = HOST_PROXY_PORT,
): Promise<string | null> {
  if (!gateway) return null;
  const proxyUrl = `http://${gateway}:${port}`;
  const cmd =
    `if command -v curl >/dev/null 2>&1; then ` +
    `curl -fsS --max-time 12 -x ${shSingle(proxyUrl)} ${shSingle(EGRESS_PROBE_URL)} >/dev/null 2>&1; ` +
    `else exit 3; fi`;
  const res = await runtime.exec(vm, cmd, { timeoutMs: 20_000 });
  return res.code === 0 ? proxyUrl : null;
}

/**
 * Resolve the full egress configuration for one VM boot and produce the env map
 * to thread into every in-VM command. Order:
 *   1. read the gateway from `ip route`.
 *   2. fix DNS (the VM resolver is dead) → enables direct NAT egress.
 *   3. probe DIRECT egress.
 *   4. probe the forward-proxy; export proxy env ONLY if it works AND direct
 *      egress is NOT already available (direct is faster + always correct here).
 * `noProxyHosts` keeps the host vLLM direct (§7.4.9). Never throws — egress is
 * best-effort and the caller surfaces a clear failure if a later step needs it.
 */
export async function resolveEgress(
  runtime: NodeRuntime,
  vm: VmHandle,
  opts: { noProxyHosts?: string[] } = {},
): Promise<VmEgress> {
  const routeRes = await runtime.exec(vm, "ip route 2>/dev/null || true");
  const gateway = parseGateway(routeRes.stdout);

  await fixVmDns(runtime, vm);
  const directEgress = await probeDirectEgress(runtime, vm);

  // Only fall back to the proxy when direct egress did not work; on this host
  // direct egress is the proven path and routing through a refused proxy would
  // break it.
  let proxyUrl: string | null = null;
  if (!directEgress) {
    proxyUrl = await probeProxy(runtime, vm, gateway);
  }

  const env: Record<string, string> = {};
  if (proxyUrl) {
    const noProxy = buildNoProxy(opts.noProxyHosts ?? []);
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }

  return { gateway, directEgress, proxyUrl, env };
}

/**
 * Host preflight: warn (do not throw, do not install) if the host forward-proxy
 * is not listening (§7.4.9 — tinyproxy is a HOST PREREQUISITE). Returns a note
 * for logging; never blocks a run, since direct NAT egress is the baseline.
 */
export async function ensureHostProxy(): Promise<{
  listening: boolean;
  note: string;
}> {
  // We only check reachability of the host proxy from the WSL host itself; the
  // app never installs or starts tinyproxy.
  const { spawn } = await import("node:child_process");
  const wslBin = process.env.ORCHESTRATOR_WSL_BIN ?? "wsl";
  const listening = await new Promise<boolean>((resolve) => {
    const child = spawn(
      wslBin,
      [
        "bash",
        "-lc",
        `pgrep -x tinyproxy >/dev/null 2>&1 && echo UP || echo DOWN`,
      ],
      { windowsHide: true },
    );
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (out += c));
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(out.includes("UP")));
  });
  const note = listening
    ? `host forward-proxy (tinyproxy:${HOST_PROXY_PORT}) is running`
    : `host forward-proxy (tinyproxy:${HOST_PROXY_PORT}) is NOT running — ` +
      `the VM will rely on direct NAT egress (still works on this host). ` +
      `To enable the proxy path: start tinyproxy on the WSL host.`;
  return { listening, note };
}

/** Single-quote a value for safe interpolation into the in-VM POSIX shell. */
function shSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
