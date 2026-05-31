import { beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import {
  type ActionCard,
  generateVapidKeys,
  type PushSubscription,
  resetVapidForTests,
  sendApprovalPush,
} from "../approval/push.js";

const mockSubscription: PushSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/mock-device",
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

const mockActionCard: ActionCard = {
  actionId: "action-123",
  title: "Deploy to Production",
  description: "Deploy v2.1.0 to production environment",
  type: "deploy",
};

describe("sendApprovalPush", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetVapidForTests();
  });

  it("calls web-push.sendNotification with payload + VAPID keys", async () => {
    const vapidKeys = generateVapidKeys();
    const send = vi.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201, body: "", headers: {} });

    const res = await sendApprovalPush(
      mockSubscription,
      mockActionCard,
      "https://example.com/approve/abc",
      "https://example.com/reject/abc",
      { vapidKeys },
    );

    expect(res).toEqual({ ok: true, status: 201 });
    expect(send).toHaveBeenCalledTimes(1);
    const [pushSub, payload] = send.mock.calls[0]!;
    expect(pushSub.endpoint).toBe(mockSubscription.endpoint);
    expect(pushSub.keys.p256dh).toBe(mockSubscription.p256dh);
    const parsed = JSON.parse(payload as string);
    expect(parsed.data.actionId).toBe("action-123");
    expect(parsed.data.approveUrl).toBe("https://example.com/approve/abc");
    expect(parsed.data.rejectUrl).toBe("https://example.com/reject/abc");
  });

  it("reports gone=true on 404/410 from the push service", async () => {
    const vapidKeys = generateVapidKeys();
    vi.spyOn(webpush, "sendNotification").mockRejectedValue({
      statusCode: 410,
      body: "subscription expired",
    });

    const res = await sendApprovalPush(
      mockSubscription,
      mockActionCard,
      "https://example.com/approve/abc",
      "https://example.com/reject/abc",
      { vapidKeys },
    );

    expect(res.ok).toBe(false);
    expect(res.gone).toBe(true);
    expect(res.status).toBe(410);
  });

  it("reports ok=false on transient server errors (no retry)", async () => {
    const vapidKeys = generateVapidKeys();
    vi.spyOn(webpush, "sendNotification").mockRejectedValue({
      statusCode: 500,
      body: "internal",
    });

    const res = await sendApprovalPush(
      mockSubscription,
      mockActionCard,
      "https://example.com/approve/abc",
      "https://example.com/reject/abc",
      { vapidKeys },
    );

    expect(res.ok).toBe(false);
    expect(res.gone).toBeFalsy();
    expect(res.status).toBe(500);
  });
});
