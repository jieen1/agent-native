// The in-VM worktree dir every microVM node operates in (DESIGN §7.1a). Lives in
// its own tiny module (no heavy imports) so light consumers — the NodeRunner,
// unit tests injecting a fake backend — can import the constant WITHOUT pulling
// in the engine-loop's `@agent-native/core/agent/engine` chain (and its
// OpenTelemetry deps the vitest ESM runner cannot resolve).
export const DEFAULT_WORKDIR = "/work";
