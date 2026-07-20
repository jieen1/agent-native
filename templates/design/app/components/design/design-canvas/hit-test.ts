import { hitTestBridgeScript } from "../../../../.generated/bridge/hit-test.generated";
import { tailwindSelfhealBridgeScript } from "../../../../.generated/bridge/tailwind-selfheal.generated";

export const LIGHTWEIGHT_HIT_TEST_BRIDGE_SCRIPT = `
<script data-agent-native-hit-test-bridge>
${hitTestBridgeScript}
</script>
`;

// Tailwind's CDN script (`@tailwindcss/browser`) can silently fail to produce
// any output under real editor load — see tailwind-selfheal.bridge.ts for the
// full reproduction. Bundled with the hit-test responder since every screen
// iframe wrapped by appendHitTestResponder can hit the same CDN race.
const TAILWIND_SELFHEAL_BRIDGE_SCRIPT = `
<script data-agent-native-tailwind-selfheal-bridge>
${tailwindSelfhealBridgeScript}
</script>
`;

const APPENDED_BRIDGES =
  TAILWIND_SELFHEAL_BRIDGE_SCRIPT + LIGHTWEIGHT_HIT_TEST_BRIDGE_SCRIPT;

export function appendHitTestResponder(html: string): string {
  if (html.includes("</body>")) {
    return html.replace(
      "</body>", // i18n-ignore generated iframe HTML marker
      APPENDED_BRIDGES + "</body>", // i18n-ignore generated iframe HTML injection
    );
  }
  if (html.includes("</html>")) {
    return html.replace(
      "</html>", // i18n-ignore generated iframe HTML marker
      APPENDED_BRIDGES + "</html>", // i18n-ignore generated iframe HTML injection
    );
  }
  return html + APPENDED_BRIDGES;
}
