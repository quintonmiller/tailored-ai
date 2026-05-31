import { AgeStore } from "../secrets/age-store.js";
import { generateVapidKeys, type VapidKeys } from "./push.js";

const VAPID_KEY = "vapid";

/**
 * Lazy-load VAPID keys from the age-encrypted store. Caches in-process
 * after first load. Throws if no keys exist (caller should direct the
 * user to `tai-executor setup vapid`).
 */
let cached: VapidKeys | null = null;

export async function loadVapidKeys(opts?: { secretsDir?: string; passphrase?: string }): Promise<VapidKeys> {
  if (cached) return cached;
  const store = new AgeStore(opts);
  const blob = await store.load(VAPID_KEY);
  if (!blob) {
    throw new Error("No VAPID keys found. Run `tai-executor setup vapid` to generate a keypair.");
  }
  const parsed = JSON.parse(blob) as VapidKeys;
  if (!parsed.publicKey || !parsed.privateKey) {
    throw new Error("VAPID blob is malformed — re-run `tai-executor setup vapid`.");
  }
  cached = parsed;
  return parsed;
}

export async function saveVapidKeys(
  keys: VapidKeys,
  opts?: { secretsDir?: string; passphrase?: string },
): Promise<void> {
  const store = new AgeStore(opts);
  await store.save(VAPID_KEY, JSON.stringify(keys));
  cached = keys;
}

export async function vapidKeysExist(opts?: { secretsDir?: string }): Promise<boolean> {
  const store = new AgeStore(opts);
  return store.exists(VAPID_KEY);
}

/**
 * Convenience: generate + persist a new keypair. Used by the
 * `setup vapid` CLI subcommand.
 */
export async function generateAndSaveVapidKeys(opts?: {
  secretsDir?: string;
  passphrase?: string;
}): Promise<VapidKeys> {
  const keys = generateVapidKeys();
  await saveVapidKeys(keys, opts);
  return keys;
}

/** Test helper: clear the in-process cache. */
export function clearVapidCacheForTests(): void {
  cached = null;
}
