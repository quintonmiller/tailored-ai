/**
 * @tailored-ai/media-r2
 *
 * Cloudflare R2 as a media store. It is S3's API, so `@tailored-ai/media-s3`
 * already talks to it given the right endpoint — this package exists for the
 * same reason `provider-deepseek` sits beside `provider-openai`: the three
 * settings you have to get exactly right are not discoverable, and getting one
 * wrong fails with a signature error that names none of them.
 *
 *   - endpoint is `https://<account-id>.r2.cloudflarestorage.com`
 *   - the signing region must be `auto`
 *   - the account endpoint is path-style
 *
 * Here they are filled in, and `accountId` is the only new thing to know.
 *
 *     plugins:
 *       - "@tailored-ai/media-r2"
 *     media:
 *       store: r2
 *       options:
 *         accountId: ${R2_ACCOUNT_ID}
 *         bucket: tai-media
 *         accessKeyId: ${R2_ACCESS_KEY_ID}
 *         secretAccessKey: ${R2_SECRET_ACCESS_KEY}
 *
 * The reason to prefer it over S3 for this workload is egress: R2 charges none,
 * and its free tier is 10 GB of storage a month. A media store whose whole job
 * is handing out links is the case that pricing was written for.
 */
import type { AgentConfig, Plugin, PluginMeta } from "@tailored-ai/core";
import { bridgeToCore, CoreTooOldError } from "@tailored-ai/media-s3";
import { R2MediaStore } from "./store.js";

export { R2MediaStore, type R2MediaStoreOptions, r2Endpoint } from "./store.js";

interface R2Config {
  accountId?: string;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
  maxBytes?: number;
  urlExpiresIn?: number;
  timeoutMs?: number;
  publicBaseUrl?: string;
  region?: string;
}

function credentialsFrom(cfg: R2Config) {
  const accessKeyId = cfg.accessKeyId || process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = cfg.secretAccessKey || process.env.R2_SECRET_ACCESS_KEY;
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
}

const plugin: Plugin = (ctx) => {
  // Through `ctx`, not a core export: a plugin's `@tailored-ai/core` is a
  // different module instance with a different registry, so calling the
  // imported function registers where nobody looks (#637).
  return ctx.mediaStores.register("r2", ({ db, options }) => {
    const cfg = options as R2Config;
    const credentials = credentialsFrom(cfg);

    if (!cfg.bucket) throw new Error("media.store is r2 but media.options.bucket is not set");
    if (!cfg.accountId && !cfg.endpoint) {
      throw new Error("media.store is r2 but neither media.options.accountId nor endpoint is set");
    }
    if (!credentials) {
      throw new Error(
        "media.store is r2 but no credentials were found — set media.options.accessKeyId / secretAccessKey, " +
          "or R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in the environment. " +
          "R2 API tokens are created under Cloudflare dashboard → R2 → Manage API Tokens.",
      );
    }

    return new R2MediaStore({
      db,
      core: bridgeToCore(),
      bucket: cfg.bucket,
      ...(cfg.accountId ? { accountId: cfg.accountId } : {}),
      ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      ...credentials,
      ...(cfg.prefix ? { prefix: cfg.prefix } : {}),
      ...(typeof cfg.maxBytes === "number" ? { maxBytes: cfg.maxBytes } : {}),
      ...(typeof cfg.urlExpiresIn === "number" ? { urlExpiresIn: cfg.urlExpiresIn } : {}),
      ...(typeof cfg.timeoutMs === "number" ? { timeoutMs: cfg.timeoutMs } : {}),
      ...(cfg.publicBaseUrl ? { publicBaseUrl: cfg.publicBaseUrl } : {}),
    });
  });
};

export const meta: PluginMeta = {
  name: "Cloudflare R2 media store",
  description: "Keeps media in R2 — S3's API with no egress fees — and serves presigned or public links.",
  registers: [{ kind: "media-store", id: "r2", configKey: "media" }],
};

export function validateConfig(config: AgentConfig): string[] {
  const media = config.media as { store?: string; options?: R2Config; urlBase?: string } | undefined;
  if (media?.store !== "r2") return [];
  const cfg = media.options ?? {};
  const warnings: string[] = [];

  if (!cfg.bucket) warnings.push("media.store is r2 but media.options.bucket is empty");
  if (!cfg.accountId && !cfg.endpoint) {
    warnings.push("media.store is r2 but media.options.accountId is empty (and no explicit endpoint)");
  }
  if (!credentialsFrom(cfg)) {
    warnings.push(
      "media.store is r2 but no credentials resolved (unresolved ${ENV_VAR}?); every media write will fail",
    );
  }
  if (cfg.region && cfg.region !== "auto") {
    // Silently ignored rather than honoured, so say so: a region here reads
    // as though it does something.
    warnings.push(`media.options.region "${cfg.region}" is ignored — R2 signs against "auto"`);
  }
  if (media.urlBase) {
    warnings.push("media.urlBase is ignored by the r2 store — links come from R2; remove it");
  }
  if (cfg.publicBaseUrl) {
    if (!/^https?:\/\//.test(cfg.publicBaseUrl)) {
      warnings.push("media.options.publicBaseUrl should be a full URL, e.g. https://media.example.com");
    }
    // Not an error — it is a legitimate setup — but it is a privacy decision
    // that deserves to be said out loud rather than inferred from a URL.
    warnings.push(
      "media.options.publicBaseUrl is set, so links are permanent and unauthenticated: " +
        "anyone with a URL can fetch that object, and it does not expire. Remove it to use presigned links.",
    );
  }
  if (cfg.urlExpiresIn !== undefined && (cfg.urlExpiresIn < 60 || cfg.urlExpiresIn > 604800)) {
    warnings.push(`media.options.urlExpiresIn ${cfg.urlExpiresIn}s is outside 60s-7d; R2 will refuse the signature`);
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
