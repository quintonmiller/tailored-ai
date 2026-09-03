/**
 * @tailored-ai/media-s3
 *
 * Keeps media in S3 instead of on the box, and hands surfaces a presigned link
 * when the bytes are too big to attach.
 *
 * The problem it solves is small and concrete: Discord caps an attachment at
 * 8 MB. Past that, core's render ladder falls back to a link — and a link is
 * only useful if it resolves from wherever the person is reading. A local disk
 * store can offer `http://127.0.0.1:3000/api/media/...`, which does not resolve
 * from a phone. A presigned S3 URL does.
 *
 *     plugins:
 *       - "@tailored-ai/media-s3"
 *     media:
 *       store: s3
 *       bucket: my-tai-media
 *       region: us-west-2
 *       accessKeyId: ${AWS_ACCESS_KEY_ID}
 *       secretAccessKey: ${AWS_SECRET_ACCESS_KEY}
 *
 * Works against anything that speaks S3 — MinIO, R2, B2 — with `endpoint` and
 * `forcePathStyle`.
 */
import type { AgentConfig, Plugin, PluginMeta } from "@tailored-ai/core";
import { bridgeToCore, CoreTooOldError } from "./core-bridge.js";
import { S3MediaStore } from "./store.js";

export { bridgeToCore, type CoreBridge, CoreTooOldError, extensionFor } from "./core-bridge.js";
export { S3Client, type S3ClientOptions, S3Error } from "./s3.js";
export type { Credentials } from "./sigv4.js";
export { EMPTY_SHA256, presignUrl, sha256Hex, signRequest, uriEncode } from "./sigv4.js";
export { S3MediaStore, type S3MediaStoreOptions } from "./store.js";

/** What this plugin reads out of the `media` block. */
interface S3MediaConfig {
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  maxBytes?: number;
  urlExpiresIn?: number;
  timeoutMs?: number;
}

/**
 * Config first, then the standard environment variables.
 *
 * Deliberately only those two. The full AWS chain — shared credentials file,
 * SSO, IMDS — needs the SDK, and pretending to support it by reading
 * `~/.aws/credentials` badly would be worse than not supporting it.
 */
function credentialsFrom(cfg: S3MediaConfig) {
  const accessKeyId = cfg.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = cfg.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = cfg.sessionToken || process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) return undefined;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

const plugin: Plugin = (ctx) => {
  // Through `ctx`, never through core's exported `registerMediaStoreFactory`.
  //
  // A plugin resolves `@tailored-ai/core` from its own node_modules, which is
  // a different module instance — and therefore a different `Registry` object
  // — from the one the runtime is using. Calling the imported function
  // registers into a registry nobody reads: the plugin loads, logs that it
  // loaded, and the store silently does not exist. `ctx` is the runtime's own
  // registry, which is the entire reason it is handed to a plugin.
  return ctx.mediaStores.register("s3", ({ db, options }) => {
    const cfg = options as S3MediaConfig;
    const region = cfg.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    const credentials = credentialsFrom(cfg);

    // Returning undefined here would make `resolveMediaStore` report "nobody
    // registered that store", which is a different and more confusing problem
    // than the real one. Throwing puts the actual cause in the startup log.
    if (!cfg.bucket) throw new Error("media.store is s3 but media.bucket is not set");
    if (!region) throw new Error("media.store is s3 but media.region is not set and AWS_REGION is empty");
    if (!credentials) {
      throw new Error(
        "media.store is s3 but no credentials were found — set media.accessKeyId / media.secretAccessKey, " +
          "or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment. " +
          "SSO and instance roles are not supported by this store.",
      );
    }

    return new S3MediaStore({
      db,
      core: bridgeToCore(),
      bucket: cfg.bucket,
      region,
      credentials,
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      ...(cfg.forcePathStyle !== undefined ? { forcePathStyle: cfg.forcePathStyle } : {}),
      ...(cfg.prefix ? { prefix: cfg.prefix } : {}),
      ...(typeof cfg.maxBytes === "number" ? { maxBytes: cfg.maxBytes } : {}),
      ...(typeof cfg.urlExpiresIn === "number" ? { urlExpiresIn: cfg.urlExpiresIn } : {}),
      ...(typeof cfg.timeoutMs === "number" ? { timeoutMs: cfg.timeoutMs } : {}),
    });
  });
};

export const meta: PluginMeta = {
  name: "S3 media store",
  description: "Keeps media in S3 (or any S3-compatible bucket) and serves surfaces a presigned link.",
  registers: [{ kind: "media-store", id: "s3", configKey: "media" }],
};

/**
 * Every check here is a way to start cleanly and then fail on the first image
 * somebody sends, which is the worst moment to find out.
 */
export function validateConfig(config: AgentConfig): string[] {
  const media = config.media as (S3MediaConfig & { store?: string; urlBase?: string }) | undefined;
  if (media?.store !== "s3") return [];

  const warnings: string[] = [];
  if (!media.bucket) warnings.push("media.store is s3 but media.bucket is empty");
  if (!media.region && !process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) {
    warnings.push("media.store is s3 but neither media.region nor AWS_REGION is set");
  }
  if (!credentialsFrom(media)) {
    warnings.push(
      "media.store is s3 but no credentials resolved (unresolved ${ENV_VAR}?); every media write will fail",
    );
  }
  if (media.urlBase) {
    // urlBase is the disk store's key. Left over from a previous config it
    // reads as though links are served locally, which they are not.
    warnings.push("media.urlBase is ignored by the s3 store — links are presigned S3 URLs; remove it");
  }
  if (media.urlExpiresIn !== undefined && (media.urlExpiresIn < 60 || media.urlExpiresIn > 604800)) {
    warnings.push(`media.urlExpiresIn ${media.urlExpiresIn}s is outside 60s-7d; S3 will refuse the signature`);
  }
  try {
    bridgeToCore();
  } catch (err) {
    if (err instanceof CoreTooOldError) warnings.push(err.message);
    else throw err;
  }
  return warnings;
}

export default plugin;
