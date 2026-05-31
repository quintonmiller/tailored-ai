import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Generate a random approval token: 32 bytes of entropy, base64url-encoded.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Hash a token string with HMAC-SHA256 using a secret key from the environment.
 * The key is read from `APPROVAL_HMAC_KEY` at call time so it can be swapped
 * between environments (test vs production).
 */
export function hashToken(token: string): string {
  const key = process.env.APPROVAL_HMAC_KEY || "";
  const hmac = createHmac("sha256", key);
  hmac.update(token);
  return hmac.digest("hex");
}

/**
 * Constant-time comparison: re-hash the submitted token and compare against
 * the stored hash using `timingSafeEqual` to prevent timing attacks.
 */
export function verifyToken(storedHash: string, submittedToken: string): boolean {
  const computedHash = hashToken(submittedToken);
  return timingSafeEqual(new TextEncoder().encode(storedHash), new TextEncoder().encode(computedHash));
}

/**
 * Check whether an expiry date has passed.
 */
export function isExpired(expiresAt: Date): boolean {
  return Date.now() > expiresAt.getTime();
}
