import { registerRequiredSecret } from "@agent-native/core/secrets";

// Deploy ship-it control (see actions/trigger-deploy.ts, app/routes/settings.tsx
// "Deploy" tab). This app is genuinely single-host today ("101"), so these are
// registered as workspace-scoped secrets rather than a speculative
// multi-environment config table — see docs/agent-native-alignment-audit.md §5
// for this project's stance on not inventing ad hoc mechanisms/premature
// abstractions. `DEPLOY_SSH_KEY_PATH` is a path on the SERVER's own
// filesystem (the same host the orchestrator process runs on, which is also
// where every prior manual deploy's SSH key already lives) — not a value ever
// pasted through a browser; keeping the raw private key content out of the
// secrets vault avoids a second place credential material can leak from.
export default async function deploySecretsPlugin(): Promise<void> {
  registerRequiredSecret({
    key: "DEPLOY_SSH_HOST",
    label: "Deploy host",
    description: "SSH host/IP of the deploy target (e.g. 192.168.1.101).",
    scope: "workspace",
    kind: "api-key",
    required: true,
  });
  registerRequiredSecret({
    key: "DEPLOY_SSH_USER",
    label: "Deploy SSH user",
    description: "SSH username on the deploy target.",
    scope: "workspace",
    kind: "api-key",
    required: true,
  });
  registerRequiredSecret({
    key: "DEPLOY_SSH_KEY_PATH",
    label: "Deploy SSH key path",
    description:
      "Path to the SSH private key ON THIS SERVER's filesystem (not the key content) — e.g. /home/user/.ssh/id_ed25519.",
    scope: "workspace",
    kind: "api-key",
    required: true,
  });
  registerRequiredSecret({
    key: "DEPLOY_REMOTE_BASE_PATH",
    label: "Deploy remote base path",
    description:
      "Base directory on the deploy host holding a real git checkout of this " +
      "monorepo — the build stage runs `git fetch/reset --hard` + `pnpm build` " +
      "here (e.g. /home/user/project/agent-native). This is the BUILD source, " +
      "not necessarily where the running containers serve from — see Deploy " +
      "live base path below.",
    scope: "workspace",
    kind: "api-key",
    required: true,
  });
  registerRequiredSecret({
    key: "DEPLOY_LIVE_BASE_PATH",
    label: "Deploy live base path",
    description:
      "Base directory the running app containers actually bind-mount their " +
      "`.output` from (e.g. 101's containers bind-mount /home/user/agent-native, " +
      "a plain rsync target with no .git — separate from the git build checkout " +
      "above). The sync stage copies each app's freshly built `.output` here " +
      "before restart. Optional: defaults to Deploy remote base path when unset, " +
      "for setups where the build checkout and the live served directory are " +
      "the same path. Set this explicitly whenever they differ.",
    scope: "workspace",
    kind: "api-key",
    required: false,
  });
  registerRequiredSecret({
    key: "DEPLOY_HEALTH_CHECK_URL",
    label: "Deploy health-check URL",
    description:
      "URL fetched after restart to verify the deploy is live (through the real gateway, not localhost).",
    scope: "workspace",
    kind: "api-key",
    required: true,
    validator: async (value) => {
      try {
        // eslint-disable-next-line no-new -- validate only, never fetch here
        new URL(value);
        return { ok: true };
      } catch {
        return { ok: false, error: "Not a valid URL" };
      }
    },
  });
  registerRequiredSecret({
    key: "DEPLOY_RESTART_COMMAND",
    label: "Deploy restart command",
    description:
      "Remote shell command run over SSH to restart the app container(s) after sync (default: docker restart an-orchestrator an-tracker).",
    scope: "workspace",
    kind: "api-key",
    required: false,
  });
}
