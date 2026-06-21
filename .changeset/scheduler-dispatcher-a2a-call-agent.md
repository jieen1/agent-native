---
"@agent-native/core": patch
---

Include the A2A `call-agent` tool in the scheduler and trigger-dispatcher agent loops. Scheduled and event-triggered agentic routines previously could not invoke other apps' agents over A2A, leaving cross-app automations (e.g. an auto-briefing routine that delegates to another app's agent) inert. The interactive and A2A handlers already exposed this tool; this aligns the background agent loops with them. Additive only.
