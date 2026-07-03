/**
 * Custom onboarding plugin for Content.
 *
 * Mounts the framework default onboarding routes, registers the
 * `contentFileUploadProvider` fallback (S3-compatible storage, or local disk
 * on a persistent volume) so self-hosted deployments can upload media
 * without Builder.io, and adds an optional "Media uploads" step that lets
 * users connect Builder.io for one-click storage instead.
 */

import { registerFileUploadProvider } from "@agent-native/core/file-upload";
import {
  createOnboardingPlugin,
  registerOnboardingStep,
} from "@agent-native/core/onboarding";

import { contentFileUploadProvider } from "../lib/upload-storage-provider.js";

const basePlugin = createOnboardingPlugin();

export default async (nitroApp: any): Promise<void> => {
  await basePlugin(nitroApp);

  registerFileUploadProvider(contentFileUploadProvider);

  registerOnboardingStep({
    id: "media-uploads",
    order: 15,
    required: false,
    title: "Media uploads",
    description:
      "Connect Builder.io for one-click media storage, or leave unconnected to use this deployment's built-in S3/local-disk storage.",
    methods: [
      {
        id: "builder",
        kind: "builder-cli-auth",
        label: "Connect Builder.io",
        description:
          "One-click file storage for media blocks. Free during beta.",
        primary: true,
        badge: "free",
        payload: { scope: "browser" },
      },
    ],
    // A fallback upload provider (S3 if configured, otherwise local disk) is
    // always registered above, so media uploads are always available —
    // Builder.io is an optional upgrade, not a requirement.
    isComplete: async () => true,
  });
};
