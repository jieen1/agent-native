import { describe, it, expect } from "vitest";

import {
  parseGateway,
  buildNoProxy,
  resolveEgress,
  HOST_PROXY_PORT,
} from "./networking.js";
import type {
  ExecOptions,
  ExecResult,
  NodeRuntime,
  VmHandle,
} from "./node-runtime.js";

/** A scriptable fake runtime: each exec is answered by a matcher → result. */
function fakeRuntime(
  handlers: { match: RegExp; result: Partial<ExecResult> }[],
): { runtime: NodeRuntime; calls: { cmd: string; env?: Record<string, string> }[] } {
  const calls: { cmd: string; env?: Record<string, string> }[] = [];
  const exec = async (
    _vm: VmHandle,
    cmd: string,
    opts?: ExecOptions,
  ): Promise<ExecResult> => {
    calls.push({ cmd, env: opts?.env });
    for (const h of handlers) {
      if (h.match.test(cmd)) {
        return { code: 0, stdout: "", stderr: "", ...h.result };
      }
    }
    return { code: 1, stdout: "", stderr: "no-match" };
  };
  const runtime = {
    kind: "fake",
    exec,
    // unused by these tests:
    provision: async () => ({}) as VmHandle,
    mount: async () => {},
    init: async () => {},
    spawn: () => {
      throw new Error("not used");
    },
    fs: () => {
      throw new Error("not used");
    },
    getPortUrl: async () => "",
    snapshot: async () => "",
    teardown: async () => {},
  } as unknown as NodeRuntime;
  return { runtime, calls };
}

const VM = { name: "vm", spec: { kind: "microvm", onFailure: "recreate" } } as VmHandle;

describe("parseGateway", () => {
  it("extracts the default-route gateway IP", () => {
    expect(
      parseGateway("default via 172.16.0.173 dev eth0\n172.16.0.172/30 dev eth0"),
    ).toBe("172.16.0.173");
  });
  it("returns null when there is no default route", () => {
    expect(parseGateway("172.16.0.172/30 dev eth0")).toBeNull();
  });
});

describe("buildNoProxy", () => {
  it("always keeps loopback + dedupes extra hosts", () => {
    const np = buildNoProxy(["localhost", "host.docker.internal"]);
    expect(np.split(",")).toContain("127.0.0.1");
    expect(np.split(",")).toContain("host.docker.internal");
    // localhost appears once despite being passed again
    expect(np.split(",").filter((h) => h === "localhost").length).toBe(1);
  });
});

describe("resolveEgress", () => {
  it("uses DIRECT egress and sets NO proxy env when direct works", async () => {
    const { runtime } = fakeRuntime([
      { match: /ip route/, result: { stdout: "default via 172.16.0.173 dev eth0" } },
      { match: /resolv\.conf/, result: { code: 0 } },
      // direct egress probe succeeds:
      { match: /api\.github\.com\/zen/, result: { code: 0 } },
    ]);
    const egress = await resolveEgress(runtime, VM);
    expect(egress.gateway).toBe("172.16.0.173");
    expect(egress.directEgress).toBe(true);
    expect(egress.proxyUrl).toBeNull();
    expect(egress.env.HTTP_PROXY).toBeUndefined(); // direct → no proxy env
  });

  it("falls back to the proxy ONLY when direct egress fails AND proxy works", async () => {
    let directCall = 0;
    const exec = async (
      _vm: VmHandle,
      cmd: string,
    ): Promise<ExecResult> => {
      if (/ip route/.test(cmd))
        return { code: 0, stdout: "default via 172.16.0.5 dev eth0", stderr: "" };
      if (/resolv\.conf/.test(cmd)) return { code: 0, stdout: "", stderr: "" };
      // The proxy probe is the command that uses `-x <proxy>`; it succeeds.
      if (/-x 'http:\/\//.test(cmd)) return { code: 0, stdout: "", stderr: "" };
      // The direct-egress probe hits the same URL but WITHOUT `-x`; it fails.
      if (/api\.github\.com\/zen/.test(cmd)) {
        directCall += 1;
        return { code: 1, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const runtime = { kind: "fake", exec } as unknown as NodeRuntime;
    const egress = await resolveEgress(runtime, VM, { noProxyHosts: ["vllm.host"] });
    expect(directCall).toBeGreaterThan(0);
    expect(egress.directEgress).toBe(false);
    expect(egress.proxyUrl).toBe(`http://172.16.0.5:${HOST_PROXY_PORT}`);
    expect(egress.env.HTTPS_PROXY).toBe(egress.proxyUrl);
    expect(egress.env.NO_PROXY).toContain("vllm.host");
    expect(egress.env.NO_PROXY).toContain("127.0.0.1");
  });

  it("sets no proxy env when BOTH direct and proxy fail (clean degrade)", async () => {
    const { runtime } = fakeRuntime([
      { match: /ip route/, result: { stdout: "default via 172.16.0.9 dev eth0" } },
      { match: /resolv\.conf/, result: { code: 0 } },
      // everything network-ish fails:
      { match: /api\.github\.com\/zen/, result: { code: 1 } },
      { match: /-x http/, result: { code: 1 } },
    ]);
    const egress = await resolveEgress(runtime, VM);
    expect(egress.directEgress).toBe(false);
    expect(egress.proxyUrl).toBeNull();
    expect(Object.keys(egress.env)).toHaveLength(0);
  });
});
