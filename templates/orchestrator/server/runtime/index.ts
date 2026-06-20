// Runtime module barrel + the runtime selector (DESIGN §7.4.2). The NodeRunner
// (P2b) calls `runtimeForSpec(spec)` to get the backend its node needs:
// `kind:"microvm"` → MicrosandboxRuntime (the real libkrun microVM, the backend
// for every tool/code/agent node); `kind:"none"` → NoneRuntime (pure-reasoning
// only). There is no third backend (DESIGN §7.0).

import { MicrosandboxRuntime } from "./microsandbox-runtime.js";
import { NoneRuntime } from "./none-runtime.js";
import type { NodeRuntime } from "./node-runtime.js";
import type { NodeRuntimeSpec } from "../../shared/types.js";

export type {
  ExecOptions,
  ExecResult,
  MountSpec,
  NodeRuntime,
  RuntimeFs,
  SpawnHandle,
  TeardownPolicy,
  VmHandle,
} from "./node-runtime.js";
export { MicrosandboxRuntime, toWslPath } from "./microsandbox-runtime.js";
export { NoneRuntime } from "./none-runtime.js";
export { wslMsb, wslMsbStream, msbAvailable, shArg } from "./wsl-msb.js";

// P2c — public egress wiring, in-VM credential mount, base-image ensure, and the
// thin in-VM git wrapper (DESIGN §7.1/§7.4.7/§7.4.8/§7.4.9).
export {
  resolveEgress,
  ensureHostProxy,
  parseGateway,
  buildNoProxy,
  HOST_PROXY_PORT,
  type VmEgress,
} from "./networking.js";
export {
  mountVmCredentials,
  resolveGithubTokenEnv,
  mountClaudeSubscription,
  VM_HOME,
  type VmCredsResult,
} from "./vm-creds.js";
export {
  ensureToolchain,
  probeTools,
  type ToolchainNeeds,
  type ToolchainResult,
} from "./vm-setup.js";
export {
  checkoutRunBranch,
  addAll,
  commit,
  pushBranch,
  openPr,
  runBranchName,
  type GitContext,
  type PushResult,
  type OpenPrResult,
} from "./git-wrapper.js";

// P2b — the 7-stage NodeRunner + the VM-bound acting bridge + executors.
export { createVmActingBridge } from "./acting-bridge.js";
export type { VmActingBridgeOptions } from "./acting-bridge.js";
export {
  NodeRunner,
  NodeRunnerExecutor,
  type NodeRunnerInput,
  type NodeRunnerResult,
} from "./node-runner.js";
export {
  VllmExecutor,
  RemoteApiExecutor,
  ClaudeCodeExecutor,
  executorForNode,
  executorForChoice,
  parseClaudeStreamJson,
  buildClaudeCommand,
  DEFAULT_VLLM_BASE_URL,
  DEFAULT_VLLM_MODEL,
  type RuntimeExecutor,
  type RuntimeExecCtx,
  type RuntimeExecResult,
  type RuntimeConfigRow,
} from "./executors/index.js";
export {
  RoutingNodeExecutor,
  loadRuntimeConfigRows,
} from "./routing-node-executor.js";

// P6 — VM-capacity backpressure (DESIGN §4.1): the distinct error types + the
// real semaphore that bounds live microVM provisions to maxConcurrentVMs.
export {
  VMCapacityExhaustedError,
  TokenBudgetExceededError,
  isVMCapacityExhausted,
  isTokenBudgetExceeded,
  VmSemaphore,
  getVmSemaphore,
  setVmSemaphore,
} from "./backpressure.js";

// Process-wide singletons: the backends are stateless drivers (all state lives
// on the per-node VmHandle), so one instance each is enough and avoids
// re-allocating the CLI bridge per node.
const microsandbox = new MicrosandboxRuntime();
const none = new NoneRuntime();

/** Pick the runtime backend for a node's runtime spec (DESIGN §7.4.2). */
export function runtimeForSpec(spec: NodeRuntimeSpec): NodeRuntime {
  return spec.kind === "none" ? none : microsandbox;
}
