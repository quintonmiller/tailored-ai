import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import type { StepContext, StepExecutor, StepResult } from "../workflows/engine.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import { deleteSecret, getSecret, listSecrets, loadSecretsMap, setSecret } from "../workflows/secrets.js";

let db: Database.Database;
const TEST_KEY = randomBytes(32);

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("workflow secrets store", () => {
  it("encrypts and decrypts a round trip", () => {
    setSecret(db, "wf", "API_TOKEN", "super-secret", TEST_KEY);
    const out = getSecret(db, "wf", "API_TOKEN", TEST_KEY);
    expect(out).toBe("super-secret");
  });

  it("ciphertext is not the plaintext", () => {
    setSecret(db, "wf", "TOKEN", "plaintext-here", TEST_KEY);
    const row = db
      .prepare("SELECT value_encrypted FROM workflow_secrets WHERE workflow_name = ? AND key = ?")
      .get("wf", "TOKEN") as { value_encrypted: string };
    expect(row.value_encrypted).not.toContain("plaintext-here");
    expect(row.value_encrypted.startsWith("v1:")).toBe(true);
  });

  it("set is idempotent — second set replaces value", () => {
    setSecret(db, "wf", "K", "v1", TEST_KEY);
    setSecret(db, "wf", "K", "v2", TEST_KEY);
    expect(getSecret(db, "wf", "K", TEST_KEY)).toBe("v2");
  });

  it("list returns metadata without values", () => {
    setSecret(db, "wf", "A", "one", TEST_KEY);
    setSecret(db, "wf", "B", "two", TEST_KEY);
    const out = listSecrets(db, "wf");
    expect(out.map((s) => s.key)).toEqual(["A", "B"]);
    expect(out.every((s) => !("value" in s))).toBe(true);
  });

  it("delete removes the entry", () => {
    setSecret(db, "wf", "TMP", "v", TEST_KEY);
    expect(deleteSecret(db, "wf", "TMP")).toBe(true);
    expect(getSecret(db, "wf", "TMP", TEST_KEY)).toBeNull();
  });

  it("decrypting with the wrong key fails", () => {
    setSecret(db, "wf", "K", "v", TEST_KEY);
    const wrongKey = randomBytes(32);
    expect(() => getSecret(db, "wf", "K", wrongKey)).toThrow();
  });

  it("secrets are visible to workflow execution via ${secrets.NAME}", async () => {
    setSecret(db, "wf", "API_TOKEN", "actual-token", TEST_KEY);

    process.env.TAI_SECRETS_KEY = TEST_KEY.toString("hex");
    // Reset key cache so the new env var takes effect.
    const { _resetSecretsKeyCache } = await import("../workflows/secrets.js");
    _resetSecretsKeyCache();

    const seen: string[] = [];
    const exec: StepExecutor = {
      type: "tool_call",
      async execute(_step: { name: string }, ctx: StepContext): Promise<StepResult> {
        const args = ctx.engine.resolve({ token: "${secrets.API_TOKEN}" }, ctx.scope) as {
          token: string;
        };
        seen.push(args.token);
        return { output: args.token };
      },
    };

    const registry = new WorkflowRegistry();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "wf",
      steps: [{ name: "step", type: "tool_call", tool: "noop" }],
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(seen).toEqual(["actual-token"]);

    delete process.env.TAI_SECRETS_KEY;
    _resetSecretsKeyCache();
  });

  it("loadSecretsMap fetches all secrets for a workflow", () => {
    setSecret(db, "wf", "A", "1", TEST_KEY);
    setSecret(db, "wf", "B", "2", TEST_KEY);
    setSecret(db, "other", "Z", "elsewhere", TEST_KEY);
    const map = loadSecretsMap(db, "wf", TEST_KEY);
    expect(map).toEqual({ A: "1", B: "2" });
  });
});
