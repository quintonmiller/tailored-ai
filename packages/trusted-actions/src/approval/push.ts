import webpush from "web-push";

/**
 * Push notification subscription (Web Push / VAPID).
 *
 * Shape matches the object the browser hands back from
 * `registration.pushManager.subscribe()` after the standard JSON
 * coercion, but split into the three fields we actually need.
 */
export interface PushSubscription {
  /** Endpoint URL for the push service (FCM / Apple / Mozilla). */
  endpoint: string;
  /** Base64url-encoded P-256 ECDH public key. */
  p256dh: string;
  /** Base64url-encoded auth secret. */
  auth: string;
}

/**
 * Action card payload for push notifications.
 */
export interface ActionCard {
  actionId: string;
  title: string;
  description: string;
  type: string;
  /**
   * Optional link to the underlying resource — for `purchase.amazon`
   * this is the product detail page. The PWA renders the decide
   * title as a link when present so the operator can verify the
   * listing before approving.
   */
  productUrl?: string;
}

/**
 * VAPID keypair. Both keys are base64url-encoded as required by
 * the Web Push spec.
 */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Generate a real VAPID keypair (P-256 ECDSA) via the web-push lib.
 * Returns base64url-encoded keys directly usable by both
 * `webpush.setVapidDetails()` and the browser's `applicationServerKey`.
 */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}

/**
 * Internal: one-time setup per process. Idempotent.
 */
let vapidConfigured = false;
function ensureVapidConfigured(keys: VapidKeys, subject: string): void {
  if (vapidConfigured) return;
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  vapidConfigured = true;
}

/**
 * Reset configured state — used by tests so they can swap keys mid-run.
 */
export function resetVapidForTests(): void {
  vapidConfigured = false;
}

export interface SendApprovalPushOpts {
  /** VAPID keypair loaded from age-store. */
  vapidKeys: VapidKeys;
  /**
   * `mailto:` subject reported to push services so they can contact
   * the operator if something goes wrong. Reads from
   * `TA_VAPID_SUBJECT` env or defaults to a placeholder.
   */
  subject?: string;
}

/**
 * Send an approval push notification via Web Push, signed with the
 * executor's VAPID keypair.
 *
 * Returns:
 *  - { ok: true, status } on 201/200/204
 *  - { ok: false, status, gone: true } on 404/410 (caller should
 *    delete the subscription)
 *  - { ok: false, status } on transient/server errors
 *  - throws on key/format errors
 */
export interface SendResult {
  ok: boolean;
  status: number;
  gone?: boolean;
  error?: string;
}

export async function sendApprovalPush(
  subscription: PushSubscription,
  actionCard: ActionCard,
  approveUrl: string,
  rejectUrl: string,
  opts: SendApprovalPushOpts,
): Promise<SendResult> {
  const subject = opts.subject || process.env.TA_VAPID_SUBJECT || "mailto:operator@example.com";
  ensureVapidConfigured(opts.vapidKeys, subject);

  const payload = JSON.stringify({
    title: actionCard.title,
    body: actionCard.description,
    data: {
      actionId: actionCard.actionId,
      type: actionCard.type,
      approveUrl,
      rejectUrl,
      ...(actionCard.productUrl ? { productUrl: actionCard.productUrl } : {}),
    },
  });

  try {
    const res = await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      },
      payload,
      { TTL: 86400 },
    );
    return { ok: true, status: res.statusCode };
  } catch (err) {
    const e = err as { statusCode?: number; body?: string; message?: string };
    const status = e.statusCode ?? 0;
    const gone = status === 404 || status === 410;
    return { ok: false, status, gone, error: e.body || e.message || "unknown" };
  }
}
