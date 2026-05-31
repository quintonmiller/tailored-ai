import { AgeStore } from "../secrets/age-store.js";

/**
 * `tai-executor setup amazon-password [--force]`
 *
 * Reads the Amazon password from stdin (no echo), encrypts it via the
 * passphrase-derived AES key, and stores it as `amazon_password` in
 * the age-encrypted secrets dir.
 *
 * Used by the production adapter on `/ap/signin` reauth. Out of scope:
 * 2FA, captcha — those still fail the action with a screenshot.
 *
 * --force: overwrite an existing blob (rotation). Without it, an
 * existing `amazon_password` is left untouched.
 */
export interface SetupAmazonPasswordOptions {
  secretsDir?: string;
  passphrase?: string;
  force?: boolean;
}

export async function setupAmazonPassword(opts?: SetupAmazonPasswordOptions): Promise<void> {
  const store = new AgeStore({
    secretsDir: opts?.secretsDir,
    passphrase: opts?.passphrase,
  });

  if (store.exists("amazon_password") && !opts?.force) {
    console.error("✗ amazon_password is already set.");
    console.error("  Re-run with --force to overwrite.");
    process.exit(2);
    return;
  }

  console.log("Enter Amazon password (no echo). Ctrl+C to cancel.");
  let password = await readPasswordFromStdin();
  if (!password) {
    console.error("✗ empty password — aborting.");
    process.exit(1);
    return;
  }

  await store.save("amazon_password", password);
  // Best-effort scrub of the local copy. Strings are immutable so this
  // only severs the binding; GC reclaims when ready.
  password = "\0".repeat(password.length);
  void password;

  console.log("✓ amazon_password saved (encrypted).");
  console.log("  The adapter will use this on /ap/signin reauth.");
}

function readPasswordFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf8");

    let buffer = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(buffer);
          return;
        }
        if (code === 3) {
          // Ctrl+C
          cleanup();
          process.stdout.write("\n");
          reject(new Error("aborted"));
          process.exit(130);
        }
        if (code === 127 || ch === "\b") {
          if (buffer.length > 0) buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };

    const cleanup = () => {
      stdin.removeListener("data", onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    stdin.on("data", onData);
  });
}
