import { createAuthPlugin } from "@agent-native/core/server";

export default createAuthPlugin({
  marketing: {
    appName: "Tracker",
    tagline:
      "AI-powered project and work-item tracker with autonomous execution.",
    features: [
      "Create projects, sprints, and work items in seconds",
      "Dispatch tasks to the Orchestrator brain for autonomous execution",
      "Track progress, activity, and completion across your team",
    ],
  },
  publicPaths: [
    "/f",
    "/api/forms/public",
    "/api/forms/og",
    "/api/submit",
    "/api/deploy-version",
  ],
});
