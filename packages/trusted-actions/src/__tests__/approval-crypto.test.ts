import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { generateToken, hashToken, isExpired, verifyToken } from "../approval/crypto.js";
import { consumeApproval, createApproval, findActionByToken } from "../approval/token-store.js";
import { migrate } from "../db/migrations.js";

// Set a stable HMAC key for all tests
process.env.APPROVAL_HMAC_KEY = "test-hmac-key-32-bytes-long-enough";

describe("generateToken", () => {
  it("returns a non-empty base64url string", () => {
    const token = generateToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates unique tokens", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken());
    }
    expect(tokens.size).toBe(100);
  });
});

describe("hashToken + verifyToken roundtrip", () => {
  it("generate → hash → verify = true", () => {
    const token = generateToken();
    const hashed = hashToken(token);
    expect(verifyToken(hashed, token)).toBe(true);
  });

  it("tampered token fails verify (constant-time)", () => {
    const token = generateToken();
    const hashed = hashToken(token);
    const last = token.at(-1)!;
    const tampered = token.slice(0, -1) + (last === "a" ? "b" : "a");
    expect(verifyToken(hashed, tampered)).toBe(false);
  });

  it("completely wrong token fails verify", () => {
    const token = generateToken();
    const hashed = hashToken(token);
    expect(verifyToken(hashed, "totally-wrong-token")).toBe(false);
  });
});

describe("isExpired", () => {
  it("returns true for past dates", () => {
    expect(isExpired(new Date(Date.now() - 1000))).toBe(true);
  });

  it("returns false for future dates", () => {
    expect(isExpired(new Date(Date.now() + 10000))).toBe(false);
  });
});

describe("token store (DB-backed)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });

  it("roundtrip: create → consume(approve) succeeds", () => {
    const token = generateToken();
    createApproval(db, "action-1", token, new Date(Date.now() + 60_000));
    const result = consumeApproval(db, "action-1", token, "approve");
    expect(result.approved).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("roundtrip: create → consume(reject) records rejection", () => {
    const token = generateToken();
    createApproval(db, "action-rej", token, new Date(Date.now() + 60_000));
    const result = consumeApproval(db, "action-rej", token, "reject");
    // approved=false because user rejected (not because of an error)
    expect(result.approved).toBe(false);
    expect(result.error).toBeUndefined();
    // Row reflects the rejection
    const row = db.prepare("SELECT approved, consumed_at FROM approvals WHERE action_id = ?").get("action-rej") as {
      approved: number;
      consumed_at: string | null;
    };
    expect(row.approved).toBe(0);
    expect(row.consumed_at).not.toBeNull();
  });

  it("expired approval returns error", () => {
    const token = generateToken();
    createApproval(db, "action-2", token, new Date(Date.now() - 1000));
    const result = consumeApproval(db, "action-2", token, "approve");
    expect(result.approved).toBe(false);
    expect(result.error).toBe("Approval expired");
  });

  it("one-time use: second consume returns error", () => {
    const token = generateToken();
    createApproval(db, "action-3", token, new Date(Date.now() + 60_000));
    const first = consumeApproval(db, "action-3", token, "approve");
    expect(first.approved).toBe(true);
    const second = consumeApproval(db, "action-3", token, "approve");
    expect(second.approved).toBe(false);
    expect(second.error).toBe("Approval already consumed");
  });

  it("wrong token returns error", () => {
    const token = generateToken();
    createApproval(db, "action-4", token, new Date(Date.now() + 60_000));
    const result = consumeApproval(db, "action-4", "wrong-token", "approve");
    expect(result.approved).toBe(false);
    expect(result.error).toBe("Invalid token");
  });

  it("unknown action returns error", () => {
    const result = consumeApproval(db, "nonexistent", generateToken(), "approve");
    expect(result.approved).toBe(false);
    expect(result.error).toBe("Approval not found");
  });

  it("findActionByToken locates approvals by cleartext token", () => {
    const token = generateToken();
    createApproval(db, "action-find", token, new Date(Date.now() + 60_000));
    expect(findActionByToken(db, token)).toBe("action-find");
    expect(findActionByToken(db, generateToken())).toBeNull();
  });
});
