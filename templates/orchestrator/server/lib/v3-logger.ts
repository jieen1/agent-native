/**
 * P4-C: Structured logging for V3 engine.
 *
 * All output is JSON via console.log so external log aggregators can parse.
 * Attach run_id / spawn_id context to a logger instance so every call
 * includes the trace identifiers.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type LogLevel = "error" | "warn" | "info" | "debug";

interface LogContext {
  module: string;
  runId?: string;
  spawnId?: string;
  nodeId?: string;
}

interface LogEntry extends LogContext {
  level: LogLevel;
  ts: string;
  msg: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  Logger factory                                                      */
/* ------------------------------------------------------------------ */

const levelMap: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function getMinLevel(): LogLevel {
  return (process.env.V3_LOG_LEVEL as LogLevel) ?? "info";
}

function shouldEmit(level: LogLevel): boolean {
  return levelMap[level] <= levelMap[getMinLevel()];
}

function emit(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

/**
 * Create a structured logger scoped to a V3 module.
 */
export function createV3Logger(
  context: string | Omit<LogContext, "module"> & { module: string },
): {
  error: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  info: (msg: string, extra?: Record<string, unknown>) => void;
  debug: (msg: string, extra?: Record<string, unknown>) => void;
  withRun: (runId: string) => ReturnType<typeof createV3Logger>;
  withSpawn: (spawnId: string) => ReturnType<typeof createV3Logger>;
  withNode: (nodeId: string) => ReturnType<typeof createV3Logger>;
} {
  const ctx: LogContext =
    typeof context === "string" ? { module: context } : context;

  function log(
    level: LogLevel,
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    if (!shouldEmit(level)) return;
    emit({
      level,
      ts: new Date().toISOString(),
      module: ctx.module,
      runId: ctx.runId,
      spawnId: ctx.spawnId,
      nodeId: ctx.nodeId,
      msg,
      ...extra,
    });
  }

  const logger = {
    error: (msg: string, extra?: Record<string, unknown>) =>
      log("error", msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) =>
      log("warn", msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) =>
      log("info", msg, extra),
    debug: (msg: string, extra?: Record<string, unknown>) =>
      log("debug", msg, extra),
    withRun(runId: string) {
      return createV3Logger({ ...ctx, runId });
    },
    withSpawn(spawnId: string) {
      return createV3Logger({ ...ctx, spawnId });
    },
    withNode(nodeId: string) {
      return createV3Logger({ ...ctx, nodeId });
    },
  };
  return logger;
}

/* ------------------------------------------------------------------ */
/*  Convenience loggers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Log a reconciler tick summary.
 */
export function logReconcilerTick(
  summary: {
    processedRuns: number;
    dispatchedNodes: number;
    skippedRuns: number;
    errors: number;
  },
  module = "reconciler",
): void {
  createV3Logger({ module }).info("reconciler tick", summary);
}

/**
 * Log a spawn lifecycle event.
 */
export function logSpawnLifecycle(
  event: {
    spawnId: string;
    action:
      | "created"
      | "dispatched"
      | "completed"
      | "failed"
      | "cancelled"
      | "retrying";
    runId?: string;
    nodeId?: string;
    errorClass?: string;
    latencyMs?: number;
    modelRef?: string;
  },
  module = "dispatcher",
): void {
  const logger = createV3Logger({
    module,
    spawnId: event.spawnId,
    runId: event.runId,
    nodeId: event.nodeId,
  });
  if (event.action === "failed") {
    logger.error("spawn failed", {
      errorClass: event.errorClass,
      latencyMs: event.latencyMs,
      modelRef: event.modelRef,
    });
  } else if (event.action === "completed") {
    logger.info("spawn completed", {
      latencyMs: event.latencyMs,
      modelRef: event.modelRef,
    });
  } else {
    logger.info("spawn " + event.action, {
      errorClass: event.errorClass,
      latencyMs: event.latencyMs,
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Default module loggers                                              */
/* ------------------------------------------------------------------ */

export const reconcilerLog = createV3Logger("reconciler");
export const dispatcherLog = createV3Logger("dispatcher");
export const poolLog = createV3Logger("pool");
export const lifecycleLog = createV3Logger("lifecycle");
