// RemoteApiExecutor — the EXECUTE stage for a node whose brain is a hosted
// model API (DESIGN §7.4.1a). Identical SHAPE to the vLLM executor (host agent
// loop, tools = the VM-bound acting bridge) — the only difference is engine
// resolution: instead of a fixed local vLLM endpoint, it resolves a real
// framework engine (e.g. `ai-sdk:anthropic`, `ai-sdk:openai`, `anthropic`) by
// the node's `engine` id, with the owner's saved API key.
//
// The agent loop runs ON THE HOST and calls the remote API from the host; only
// the TOOL side effects cross into the node's microVM. (A remote-API node does
// not need VM public egress for the model — that call is host→provider.)
//
// E2E is skippable when no provider key is configured for the run owner; the
// executor still builds and resolves an engine, and surfaces a clear error if
// the key is missing rather than silently inheriting a deployment key.

import { getOwnerActiveApiKey } from "@agent-native/core/server";
import { resolveEngine } from "@agent-native/core/agent/engine";

import { runEngineLoopInVm } from "./engine-loop.js";
import type {
  RuntimeExecCtx,
  RuntimeExecResult,
  RuntimeExecutor,
} from "./types.js";

export class RemoteApiExecutor implements RuntimeExecutor {
  readonly kind = "remote-api";

  async run(ctx: RuntimeExecCtx): Promise<RuntimeExecResult> {
    const engineOption = ctx.node.engine;
    if (!engineOption || engineOption.trim() === "") {
      throw new Error(
        "RemoteApiExecutor requires node.engine (a framework engine id, e.g. " +
          '"ai-sdk:anthropic"); none was set',
      );
    }

    // Owner's saved provider key (DESIGN §7.4.7). May be undefined for local
    // single-tenant; resolveEngine then falls back to env per its own rules.
    const apiKey = await getOwnerActiveApiKey(ctx.ownerEmail);

    const engine = await resolveEngine({
      engineOption,
      apiKey,
      model: ctx.node.model,
    });

    const model =
      ctx.node.model && ctx.node.model.trim() !== ""
        ? ctx.node.model
        : engine.defaultModel;

    return runEngineLoopInVm({ ctx, engine, model, kind: this.kind });
  }
}
