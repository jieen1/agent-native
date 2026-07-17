// Nitro plugin: v3-writeback-outbox-sweep
//
// Mounted at server startup to register the periodic sweep that drains the
// persistent writeback outbox (task board #38 follow-up) — see
// server/queue/v3-writeback-outbox-sweep.ts for the full rationale.

import { startWritebackOutboxSweep } from "../queue/v3-writeback-outbox-sweep.js";

export default function v3WritebackOutboxSweepPlugin() {
  startWritebackOutboxSweep();
}
