import { createAuthPlugin } from "@agent-native/core/server";

const rawAppTitle = "{{APP_TITLE}}";
const appTitle =
  rawAppTitle === "{" + "{APP_TITLE}}" ? "Orchestrator" : rawAppTitle;

export default createAuthPlugin({
  marketing: {
    appName: appTitle,
    tagline:
      "Multi-model workflow execution engine — author DAGs, run them across models in isolated workspaces, and observe every run, spawn, and patch.",
    features: [
      "Author and run workflow DAGs across multiple models",
      "Live-patch the not-yet-executed part of a running run",
      "Isolated microVM / ACP workspaces with full observability",
    ],
  },
  publicPaths: ["/api/deploy-version"],
});
