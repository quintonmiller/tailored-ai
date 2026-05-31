import { beforeEach, describe, expect, it } from "vitest";
import { __clearRegistry, register } from "../actions/registry.js";
import { findActionByToken } from "../approval/token-store.js";
import { closeDb, getDb } from "../db/schema.js";
import { app } from "../server.js";

process.env.APPROVAL_HMAC_KEY = "test-hmac-key-for-server-tests";

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.TA_SHARED_SECRET ?? ""}`,
  };
}

describe("Server", () => {
  beforeEach(() => {
    // Reset module-level singletons between tests.
    closeDb();
    __clearRegistry();
    process.env.TA_SHARED_SECRET = "test-secret-123";
    delete process.env.TA_CAP_PER_REQUEST;
    delete process.env.TA_CAP_PER_DAY;
    delete process.env.TA_CAP_PER_MONTH;
    // Touch the DB so it's fresh for every test
    getDb();
  });

  it("GET /health returns ok with empty actions list", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; actions: string[] };
    expect(body.status).toBe("ok");
    expect(body.actions).toEqual([]);
  });

  describe("POST /internal/enqueue", () => {
    it("returns 401 without Authorization header", async () => {
      const res = await app.request("/internal/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "test", input: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong secret", async () => {
      const res = await app.request("/internal/enqueue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-secret",
        },
        body: JSON.stringify({ type: "test", input: {} }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 400 for unknown action type", async () => {
      const res = await app.request("/internal/enqueue", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ type: "nope", input: {} }),
      });
      expect(res.status).toBe(400);
    });

    it("enqueues a valid action and returns action_id + pending_approval", async () => {
      register("test.simple", {
        type: "test.simple",
        validate: () => ({ valid: true }),
        describeForApproval: async () => ({
          title: "Test approval",
          body: "Approve this test action",
          estimatedCost: "$5.00",
        }),
        execute: async () => ({ ok: true }),
      });

      const res = await app.request("/internal/enqueue", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          type: "test.simple",
          input: { hello: "world" },
          requested_by: "test-agent",
        }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { action_id: string; status: string; expires_at: string };
      expect(body.action_id).toMatch(/^ta_/);
      expect(body.status).toBe("pending_approval");
      expect(typeof body.expires_at).toBe("string");

      // Row landed
      const row = getDb().prepare("SELECT type, status FROM actions WHERE id = ?").get(body.action_id) as {
        type: string;
        status: string;
      };
      expect(row.type).toBe("test.simple");
      expect(row.status).toBe("pending_approval");
    });

    it("rejects enqueue when per-request cap exceeded", async () => {
      process.env.TA_CAP_PER_REQUEST = "10";
      register("test.expensive", {
        type: "test.expensive",
        validate: () => ({ valid: true }),
        describeForApproval: async () => ({ title: "t", body: "b" }),
        execute: async () => ({ ok: true }),
      });

      const res = await app.request("/internal/enqueue", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          type: "test.expensive",
          input: { max_price: 100 },
          requested_by: "test",
        }),
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: string; exceeded_cap: string };
      expect(body.exceeded_cap).toBe("per_request");
    });
  });

  describe("approval flow", () => {
    beforeEach(() => {
      register("test.flow", {
        type: "test.flow",
        validate: () => ({ valid: true }),
        describeForApproval: async () => ({ title: "Flow", body: "Approve" }),
        execute: async () => ({ ok: true }),
      });
    });

    async function _enqueue(): Promise<{ id: string; token: string }> {
      const res = await app.request("/internal/enqueue", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          type: "test.flow",
          input: { max_price: 5 },
          requested_by: "test",
        }),
      });
      const body = (await res.json()) as { action_id: string };
      // Recover the cleartext token via DB lookup (test-only — in real flow the token only goes out via push).
      const tokenRow = getDb().prepare("SELECT token_hash FROM approvals WHERE action_id = ?").get(body.action_id) as {
        token_hash: string;
      };
      // We can't reverse the hash; instead, generate one and verify the round-trip works on a fresh row.
      // For this test we look at the test infrastructure: the token lives in-memory only at enqueue time,
      // so we test approve/reject by inspecting status transitions via a parallel direct lookup.
      void tokenRow;
      return { id: body.action_id, token: "" };
    }

    it("approving via /approve/:token transitions the action to approved", async () => {
      // Drive the flow with a known token by inserting it directly into the
      // store after enqueue. (Test-only path; in production the token is
      // never exposed outside push.)
      const { generateToken } = await import("../approval/crypto.js");
      const { createApproval } = await import("../approval/token-store.js");
      const db = getDb();
      const id = "ta_test_app";
      db.prepare(
        `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, "test.flow", "{}", "pending_approval", "tester", new Date().toISOString());
      const token = generateToken();
      createApproval(db, id, token, new Date(Date.now() + 60_000));

      const res = await app.request(`/approve/${token}`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; action_id: string };
      expect(body.status).toBe("approved");
      expect(body.action_id).toBe(id);

      const row = db.prepare("SELECT status FROM actions WHERE id = ?").get(id) as { status: string };
      expect(row.status).toBe("approved");
    });

    it("rejecting via /reject/:token transitions the action to rejected", async () => {
      const { generateToken } = await import("../approval/crypto.js");
      const { createApproval } = await import("../approval/token-store.js");
      const db = getDb();
      const id = "ta_test_rej";
      db.prepare(
        `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, "test.flow", "{}", "pending_approval", "tester", new Date().toISOString());
      const token = generateToken();
      createApproval(db, id, token, new Date(Date.now() + 60_000));

      const res = await app.request(`/reject/${token}`, { method: "POST" });
      expect(res.status).toBe(200);
      const row = db.prepare("SELECT status FROM actions WHERE id = ?").get(id) as { status: string };
      expect(row.status).toBe("rejected");
    });

    it("/approve/:bogus returns 410", async () => {
      const res = await app.request("/approve/bogus-token-not-real", { method: "POST" });
      expect(res.status).toBe(410);
    });

    it("replay attempts return 410", async () => {
      const { generateToken } = await import("../approval/crypto.js");
      const { createApproval } = await import("../approval/token-store.js");
      const db = getDb();
      const id = "ta_test_replay";
      db.prepare(
        `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, "test.flow", "{}", "pending_approval", "tester", new Date().toISOString());
      const token = generateToken();
      createApproval(db, id, token, new Date(Date.now() + 60_000));

      const first = await app.request(`/approve/${token}`, { method: "POST" });
      expect(first.status).toBe(200);
      const second = await app.request(`/approve/${token}`, { method: "POST" });
      expect(second.status).toBe(410);
    });
  });

  describe("GET /actions", () => {
    it("returns pending actions by default", async () => {
      register("test.list", {
        type: "test.list",
        validate: () => ({ valid: true }),
        describeForApproval: async () => ({ title: "t", body: "b" }),
        execute: async () => ({ ok: true }),
      });
      const enq = await app.request("/internal/enqueue", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ type: "test.list", input: { max_price: 1 }, requested_by: "t" }),
      });
      expect(enq.status).toBe(202);

      const res = await app.request("/actions");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { actions: Array<{ status: string }> };
      expect(body.actions.length).toBeGreaterThan(0);
      expect(body.actions.every((a) => a.status === "pending_approval")).toBe(true);
    });
  });

  describe("POST /actions/:id/cancel", () => {
    it("marks pending action as rejected and audits", async () => {
      const db = getDb();
      const id = "ta_cancel";
      db.prepare(
        `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, "test.x", "{}", "pending_approval", "tester", new Date().toISOString());

      const res = await app.request(`/actions/${id}/cancel`, { method: "POST" });
      expect(res.status).toBe(200);
      const row = db.prepare("SELECT status, error FROM actions WHERE id = ?").get(id) as {
        status: string;
        error: string | null;
      };
      expect(row.status).toBe("rejected");
      expect(row.error).toMatch(/cancelled/);
      const audit = db.prepare("SELECT action FROM audit_log WHERE action = 'cancel'").get();
      expect(audit).toBeDefined();
    });

    it("404 for unknown id", async () => {
      const res = await app.request("/actions/missing/cancel", { method: "POST" });
      expect(res.status).toBe(404);
    });

    it("409 when action is not pending", async () => {
      const db = getDb();
      const id = "ta_notpending";
      db.prepare(
        `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, "test.x", "{}", "completed", "tester", new Date().toISOString());

      const res = await app.request(`/actions/${id}/cancel`, { method: "POST" });
      expect(res.status).toBe(409);
    });
  });

  describe("GET /internal/actions/:id/status", () => {
    it("returns the action status", async () => {
      const db = getDb();
      const id = "ta_status_check";
      db.prepare(
        `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, "test.x", "{}", "pending_approval", "tester", new Date().toISOString());

      const res = await app.request(`/internal/actions/${id}/status`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("pending_approval");
    });

    it("returns 404 for unknown action", async () => {
      const res = await app.request("/internal/actions/nope/status", {
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });
});

// Sanity-touch findActionByToken so the lint sees it as used.
void findActionByToken;
