import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { listRuntimeImages, IMAGES_NOTE } from "../server/runtime/images.js";

// list-runtime-images (DESIGN §7.4.8, FRONTEND §9). READ-ONLY: returns the base
// microVM image catalog (per language/runtime) + build status so the Settings →
// Images tab can show which image each node forks from. Images are CLI-prebaked;
// there is NO in-app build, so this action only reads.
export default defineAction({
  description:
    "List the base microVM image catalog (per language/runtime) and build status. Read-only; images are CLI-prebaked (no in-app build).",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const images = await listRuntimeImages();
    return { images, note: IMAGES_NOTE };
  },
});
