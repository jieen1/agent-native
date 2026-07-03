/**
 * File upload storage provider for the Content template.
 *
 * Self-hosted deployments without Builder.io get a 503 from
 * `/_agent-native/file-upload` because no non-Builder provider is
 * registered, which blocks embedding screenshots/images in documents. This
 * registers a fallback provider — S3-compatible object storage when
 * configured, otherwise local disk under a persistent volume — so uploads
 * always work.
 *
 * Activation: this provider must never override an already-configured
 * Builder.io connection (env var OR Settings/OAuth DB connection). Its sync
 * `isConfigured()` always returns `false` because a DB-only Builder
 * connection can't be detected synchronously; the real gate is the async
 * `isConfiguredForRequest()`, which defers whenever Builder is available.
 * See `packages/core/src/file-upload/registry.ts` for the precedence rules
 * this relies on.
 *
 * URL stability: uploaded files must stay readable across container
 * restarts, so this never hands out an expiring presigned URL as the
 * primary link. Reads are proxied through this app's own
 * `/api/uploads/[...path]` route (local disk, or S3 without a public base
 * URL); the direct public URL is only used when explicitly configured via
 * `*_PUBLIC_BASE_URL`.
 *
 * SigV4 signing mirrors `templates/assets/server/lib/s3-upload-provider.ts`
 * (Web Crypto, no AWS SDK).
 *
 * Env vars (first found wins):
 *   CONTENT_STORAGE_BUCKET | S3_BUCKET | MINIO_BUCKET — required for S3
 *   CONTENT_STORAGE_ACCESS_KEY_ID | S3_ACCESS_KEY_ID | MINIO_ACCESS_KEY — required for S3
 *   CONTENT_STORAGE_SECRET_ACCESS_KEY | S3_SECRET_ACCESS_KEY | MINIO_SECRET_KEY — required for S3
 *   CONTENT_STORAGE_ENDPOINT | S3_ENDPOINT | MINIO_ENDPOINT — required for S3
 *   CONTENT_STORAGE_REGION | S3_REGION | MINIO_REGION — optional, default "auto"
 *   CONTENT_STORAGE_PUBLIC_BASE_URL | S3_PUBLIC_BASE_URL — optional
 *   CONTENT_UPLOADS_DIR — optional, local-disk fallback dir (default `<cwd>/data/uploads`)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

import type { FileUploadProvider } from "@agent-native/core/file-upload";
import {
  getConfiguredAppBasePath,
  resolveHasBuilderPrivateKey,
} from "@agent-native/core/server";

interface S3Config {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  publicBaseUrl: string | null;
}

function readS3Config(): S3Config | null {
  const env = process.env;
  const bucket =
    env.CONTENT_STORAGE_BUCKET || env.S3_BUCKET || env.MINIO_BUCKET;
  const accessKeyId =
    env.CONTENT_STORAGE_ACCESS_KEY_ID ||
    env.S3_ACCESS_KEY_ID ||
    env.MINIO_ACCESS_KEY;
  const secretAccessKey =
    env.CONTENT_STORAGE_SECRET_ACCESS_KEY ||
    env.S3_SECRET_ACCESS_KEY ||
    env.MINIO_SECRET_KEY;
  const endpoint =
    env.CONTENT_STORAGE_ENDPOINT || env.S3_ENDPOINT || env.MINIO_ENDPOINT;
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return null;
  return {
    region:
      env.CONTENT_STORAGE_REGION || env.S3_REGION || env.MINIO_REGION || "auto",
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: endpoint.replace(/\/+$/, ""),
    publicBaseUrl:
      (
        env.CONTENT_STORAGE_PUBLIC_BASE_URL ||
        env.S3_PUBLIC_BASE_URL ||
        ""
      ).replace(/\/+$/, "") || null,
  };
}

// ── SigV4 helpers (Web Crypto, no SDK) ────────────────────────────────
// Mirrors templates/assets/server/lib/s3-upload-provider.ts.

async function hmac(key: ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
}

async function sha256(data: Uint8Array): Promise<string> {
  const ab = new ArrayBuffer(data.byteLength);
  new Uint8Array(ab).set(data);
  const buf = await crypto.subtle.digest("SHA-256", ab);
  return toHex(buf);
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

async function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
): Promise<ArrayBuffer> {
  const kSecret = new TextEncoder().encode(`AWS4${secret}`);
  const kDate = await hmac(kSecret.buffer as ArrayBuffer, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function rfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function canonicalObjectUri(cfg: S3Config, key: string): string {
  return `/${cfg.bucket}/${key.split("/").map(rfc3986).join("/")}`;
}

function publicObjectUrl(cfg: S3Config, key: string): string | null {
  if (!cfg.publicBaseUrl) return null;
  return `${cfg.publicBaseUrl}/${key.split("/").map(rfc3986).join("/")}`;
}

function s3Timestamp() {
  const amzDate =
    new Date()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "")
      .slice(0, 15) + "Z";
  return {
    amzDate,
    dateStamp: amzDate.slice(0, 8),
  };
}

async function authorizationHeader(input: {
  cfg: S3Config;
  method: "GET" | "PUT";
  key: string;
  headers: Record<string, string>;
  payloadHash: string;
  query?: string;
  dateStamp: string;
  amzDate: string;
}): Promise<string> {
  const credentialScope = `${input.dateStamp}/${input.cfg.region}/s3/aws4_request`;
  const signedHeaderKeys = Object.keys(input.headers).sort();
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalHeaders =
    signedHeaderKeys.map((k) => `${k}:${input.headers[k]}`).join("\n") + "\n";
  const canonicalRequest = [
    input.method,
    canonicalObjectUri(input.cfg, input.key),
    input.query ?? "",
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const crHash = await sha256(new TextEncoder().encode(canonicalRequest));
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    credentialScope,
    crHash,
  ].join("\n");
  const signingKey = await deriveSigningKey(
    input.cfg.secretAccessKey,
    input.dateStamp,
    input.cfg.region,
  );
  const signature = toHex(await hmac(signingKey, stringToSign));
  return (
    `AWS4-HMAC-SHA256 Credential=${input.cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

async function putObject(
  cfg: S3Config,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const { amzDate, dateStamp } = s3Timestamp();
  const hostUrl = new URL(cfg.endpoint);
  const payloadHash = await sha256(body);
  const headers: Record<string, string> = {
    host: hostUrl.host,
    "content-type": contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const authorization = await authorizationHeader({
    cfg,
    method: "PUT",
    key,
    headers,
    payloadHash,
    dateStamp,
    amzDate,
  });

  const res = await fetch(`${cfg.endpoint}${canonicalObjectUri(cfg, key)}`, {
    method: "PUT",
    headers: {
      ...headers,
      Authorization: authorization,
      "Content-Length": String(body.byteLength),
    },
    body: body.buffer.slice(
      body.byteOffset,
      body.byteOffset + body.byteLength,
    ) as BodyInit,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `S3 PutObject failed (${res.status}): ${text || res.statusText}`,
    );
  }
}

/** Signed GET — used by the `/api/uploads/s3/...` read-back route. */
export async function getS3Object(key: string): Promise<Buffer> {
  const cfg = readS3Config();
  if (!cfg) throw new Error("S3 env vars not configured");
  const { amzDate, dateStamp } = s3Timestamp();
  const hostUrl = new URL(cfg.endpoint);
  const headers: Record<string, string> = {
    host: hostUrl.host,
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-date": amzDate,
  };
  const authorization = await authorizationHeader({
    cfg,
    method: "GET",
    key,
    headers,
    payloadHash: "UNSIGNED-PAYLOAD",
    dateStamp,
    amzDate,
  });
  const res = await fetch(`${cfg.endpoint}${canonicalObjectUri(cfg, key)}`, {
    headers: { ...headers, Authorization: authorization },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `S3 GetObject failed (${res.status}): ${text || res.statusText}`,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── Local disk fallback (persistent volume) ────────────────────────────
// `process.cwd()/data` is the framework's persistent-volume convention
// (see packages/core/src/db/client.ts prepareLocalSqliteUrl).

function uploadsDir(): string {
  return process.env.CONTENT_UPLOADS_DIR
    ? resolve(process.env.CONTENT_UPLOADS_DIR)
    : join(process.cwd(), "data", "uploads");
}

/** Resolve a key to a path under the uploads dir, rejecting traversal. */
function safeLocalKeyPath(key: string): string {
  const base = uploadsDir();
  const full = normalize(join(base, key));
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error("Invalid upload key");
  }
  return full;
}

async function writeLocalObject(key: string, bytes: Uint8Array): Promise<void> {
  const filePath = safeLocalKeyPath(key);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

/** Used by the `/api/uploads/local/...` read-back route. */
export async function readLocalObject(key: string): Promise<Buffer> {
  return readFile(safeLocalKeyPath(key));
}

// ── Provider ──────────────────────────────────────────────────────────

function objectKeyFor(filename?: string): string {
  const ext =
    filename
      ?.split(".")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "bin";
  const now = new Date();
  const prefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}/${Date.now()}-${rand}.${ext}`;
}

export const contentFileUploadProvider: FileUploadProvider = {
  id: "content-storage",
  name: "Content storage (S3-compatible or local disk)",
  // Always false: a Builder connection made via Settings/OAuth lives in SQL
  // and can't be checked synchronously, so this provider must never claim
  // availability at the sync layer (getActiveFileUploadProvider). The real
  // check — which correctly defers to Builder in both the env and DB case —
  // is isConfiguredForRequest below.
  isConfigured: () => false,
  isConfiguredForRequest: async () => {
    try {
      if (await resolveHasBuilderPrivateKey()) return false;
    } catch {
      // Credential lookup failed (e.g. DB unavailable) — offer this
      // fallback rather than leaving uploads broken.
    }
    return true;
  },
  upload: async ({ data, filename, mimeType }) => {
    const bytes =
      data instanceof Uint8Array
        ? data
        : new Uint8Array(data as unknown as ArrayBuffer);
    const contentType = mimeType || "application/octet-stream";
    const objectKey = objectKeyFor(filename);
    const cfg = readS3Config();
    // The app may be deployed under a non-root base path (e.g.
    // APP_BASE_PATH=/content). Relative read-back URLs must include it so
    // they resolve correctly as <img src> — getConfiguredAppBasePath()
    // returns "" when the app is deployed at "/".
    const basePath = getConfiguredAppBasePath();

    if (cfg) {
      await putObject(cfg, objectKey, bytes, contentType);
      const publicUrl = publicObjectUrl(cfg, objectKey);
      return {
        url: publicUrl ?? `${basePath}/api/uploads/s3/${objectKey}`,
        id: `s3:${objectKey}`,
        provider: "content-storage",
      };
    }

    await writeLocalObject(objectKey, bytes);
    return {
      url: `${basePath}/api/uploads/local/${objectKey}`,
      id: `local:${objectKey}`,
      provider: "content-storage",
    };
  },
};
