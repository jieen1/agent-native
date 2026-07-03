/**
 * Read-back route for files stored by `contentFileUploadProvider`
 * (server/lib/upload-storage-provider.ts).
 *
 * The `[...path]` catch-all captures `<backend>/<objectKey>`, e.g.
 * `s3/2026/07/1234-abcd.png` or `local/2026/07/1234-abcd.png`. Kept under
 * this template's own `/api/*` namespace — `/_agent-native/*` is reserved
 * for the framework.
 */

import { createError, defineEventHandler, setHeader } from "h3";

import {
  getS3Object,
  readLocalObject,
} from "../../../lib/upload-storage-provider.js";

const EXT_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  pdf: "application/pdf",
};

function contentTypeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return EXT_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export default defineEventHandler(async (event) => {
  const params = event.context.params as { path?: string | string[] };
  const raw = params?.path;
  const full = Array.isArray(raw) ? raw.join("/") : (raw ?? "");

  const slashIndex = full.indexOf("/");
  if (slashIndex === -1) {
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid upload path",
    });
  }
  const backend = full.slice(0, slashIndex);
  const key = full.slice(slashIndex + 1);
  if (backend !== "s3" && backend !== "local") {
    throw createError({
      statusCode: 400,
      statusMessage: "Unknown storage backend",
    });
  }

  let bytes: Buffer;
  try {
    bytes =
      backend === "s3" ? await getS3Object(key) : await readLocalObject(key);
  } catch {
    throw createError({ statusCode: 404, statusMessage: "Upload not found" });
  }

  setHeader(event, "content-type", contentTypeFor(key));
  setHeader(event, "cache-control", "public, max-age=31536000, immutable");
  return bytes;
});
