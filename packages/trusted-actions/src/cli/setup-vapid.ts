import { generateAndSaveVapidKeys, loadVapidKeys, vapidKeysExist } from "../approval/vapid-store.js";

/**
 * `tai-executor setup vapid` — one-time keygen for Web Push.
 * Idempotent: refuses to overwrite an existing keypair unless --force
 * is passed (so a rotation is always explicit).
 */
export async function setupVapid(opts: { force?: boolean } = {}): Promise<void> {
  if (!process.env.TAI_EXECUTOR_PASSPHRASE) {
    console.error("✗ TAI_EXECUTOR_PASSPHRASE must be set so VAPID keys can be encrypted.");
    process.exit(1);
  }

  if ((await vapidKeysExist()) && !opts.force) {
    console.log("✓ VAPID keypair already exists at ~/.tai-executor/secrets/vapid.json");
    const keys = await loadVapidKeys();
    console.log("");
    console.log("Public key (paste into PWA / config if needed):");
    console.log(`  ${keys.publicKey}`);
    console.log("");
    console.log("To rotate (invalidates all existing push subscriptions): re-run with --force.");
    return;
  }

  console.log("▸ generating new VAPID keypair (P-256)…");
  const keys = await generateAndSaveVapidKeys();
  console.log("✓ wrote ~/.tai-executor/secrets/vapid.json (age-encrypted)");
  console.log("");
  console.log("Public key (the PWA fetches this via GET /vapid/public-key):");
  console.log(`  ${keys.publicKey}`);
  console.log("");
  console.log("Restart the executor so subsequent enqueues can sign push notifications.");
}
