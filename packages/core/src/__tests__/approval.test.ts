import { describe, expect, it } from "vitest";
import { evaluatePermission, type PermissionsConfig } from "../approval.js";

const basePermissions: PermissionsConfig = {
  defaultMode: "auto",
  timeoutMs: 300000,
  timeoutAction: "reject",
  tools: {},
};

describe("evaluatePermission", () => {
  it("returns auto when permissions is undefined", () => {
    expect(evaluatePermission("exec", { command: "ls" }, undefined)).toBe("auto");
  });

  it("returns defaultMode for unknown tools", () => {
    expect(evaluatePermission("unknown_tool", {}, basePermissions)).toBe("auto");

    const strict: PermissionsConfig = { ...basePermissions, defaultMode: "approve" };
    expect(evaluatePermission("unknown_tool", {}, strict)).toBe("approve");
  });

  it("returns auto for mode=auto", () => {
    const perms: PermissionsConfig = {
      ...basePermissions,
      tools: { read: { mode: "auto" } },
    };
    expect(evaluatePermission("read", { file: "/etc/passwd" }, perms)).toBe("auto");
  });

  it("returns approve for mode=approve", () => {
    const perms: PermissionsConfig = {
      ...basePermissions,
      tools: { write: { mode: "approve" } },
    };
    expect(evaluatePermission("write", { file: "test.txt", content: "hello" }, perms)).toBe("approve");
  });

  it("evaluates conditional rules with first-match-wins", () => {
    const perms: PermissionsConfig = {
      ...basePermissions,
      tools: {
        exec: {
          mode: "conditional",
          rules: [
            { match: { command: "^(ls|cat|head|pwd|echo)" }, action: "auto" },
            { match: { command: "(rm|dd|mkfs|shutdown)" }, action: "approve" },
            { match: {}, action: "approve" },
          ],
        },
      },
    };

    // Matches first rule — auto
    expect(evaluatePermission("exec", { command: "ls -la" }, perms)).toBe("auto");
    expect(evaluatePermission("exec", { command: "cat /etc/hosts" }, perms)).toBe("auto");
    expect(evaluatePermission("exec", { command: "echo hello" }, perms)).toBe("auto");

    // Matches second rule — approve
    expect(evaluatePermission("exec", { command: "rm -rf /old" }, perms)).toBe("approve");

    // Matches catch-all — approve
    expect(evaluatePermission("exec", { command: "curl http://example.com" }, perms)).toBe("approve");
  });

  it("handles multi-field match rules", () => {
    const perms: PermissionsConfig = {
      ...basePermissions,
      tools: {
        gmail: {
          mode: "conditional",
          rules: [
            { match: { action: "^check$" }, action: "auto" },
            { match: { action: "^send$" }, action: "approve" },
          ],
        },
      },
    };

    expect(evaluatePermission("gmail", { action: "check" }, perms)).toBe("auto");
    expect(evaluatePermission("gmail", { action: "send", to: "user@example.com" }, perms)).toBe("approve");
  });

  it("falls back to defaultMode when no rule matches", () => {
    const perms: PermissionsConfig = {
      ...basePermissions,
      defaultMode: "approve",
      tools: {
        exec: {
          mode: "conditional",
          rules: [
            { match: { command: "^ls$" }, action: "auto" },
            // No catch-all
          ],
        },
      },
    };

    expect(evaluatePermission("exec", { command: "ls" }, perms)).toBe("auto");
    expect(evaluatePermission("exec", { command: "rm something" }, perms)).toBe("approve");
  });

  it("returns catch-all when match is empty", () => {
    const perms: PermissionsConfig = {
      ...basePermissions,
      tools: {
        exec: {
          mode: "conditional",
          rules: [{ match: {}, action: "approve" }],
        },
      },
    };

    expect(evaluatePermission("exec", { command: "anything" }, perms)).toBe("approve");
    expect(evaluatePermission("exec", {}, perms)).toBe("approve");
  });

  it("handles missing args for conditional rules", () => {
    const perms: PermissionsConfig = {
      ...basePermissions,
      tools: {
        exec: {
          mode: "conditional",
          rules: [
            { match: { command: "^ls$" }, action: "auto" },
            { match: {}, action: "approve" },
          ],
        },
      },
    };

    // No command arg — first rule doesn't match, catch-all matches
    expect(evaluatePermission("exec", {}, perms)).toBe("approve");
  });

  it("handles invalid regex in rules gracefully", () => {
    const perms: PermissionsConfig = {
      ...basePermissions,
      tools: {
        exec: {
          mode: "conditional",
          rules: [
            { match: { command: "[invalid" }, action: "auto" },
            { match: {}, action: "approve" },
          ],
        },
      },
    };

    // Invalid regex — treated as non-match, falls through to catch-all
    expect(evaluatePermission("exec", { command: "ls" }, perms)).toBe("approve");
  });

  it("conditional with no rules falls back to defaultMode", () => {
    const perms: PermissionsConfig = {
      ...basePermissions,
      defaultMode: "auto",
      tools: {
        exec: { mode: "conditional" },
      },
    };

    expect(evaluatePermission("exec", { command: "anything" }, perms)).toBe("auto");
  });
});

describe("evaluatePermission — rules that reach an absent argument", () => {
  const perms = (rules: Array<{ match: Record<string, string | null>; action: "auto" | "approve" }>) =>
    ({
      defaultMode: "auto",
      timeoutMs: 0,
      timeoutAction: "reject",
      tools: { memory: { mode: "conditional", rules } },
    }) as unknown as PermissionsConfig;

  it("matches a rule that requires the argument to be absent", () => {
    // Previously inexpressible: any missing argument failed the match outright,
    // so a rule could only describe what the model DID pass. The dangerous call
    // is often the one that passes nothing and takes a default.
    const p = perms([{ match: { scope: null }, action: "approve" }]);

    expect(evaluatePermission("memory", { file: "notes.md" }, p)).toBe("approve");
    expect(evaluatePermission("memory", { file: "notes.md", scope: "profile" }, p)).toBe("auto");
  });

  it("treats an empty string as absent, because models emit it for 'unset'", () => {
    const p = perms([{ match: { scope: null }, action: "approve" }]);

    expect(evaluatePermission("memory", { scope: "" }, p)).toBe("approve");
  });

  it("still requires a present argument for a regex rule", () => {
    const p = perms([{ match: { scope: "^global$" }, action: "approve" }]);

    expect(evaluatePermission("memory", { scope: "global" }, p)).toBe("approve");
    expect(evaluatePermission("memory", {}, p)).toBe("auto");
    expect(evaluatePermission("memory", { scope: "" }, p)).toBe("auto");
  });

  it("combines present and absent conditions in one rule", () => {
    const p = perms([{ match: { action: "^write$", scope: null }, action: "approve" }]);

    expect(evaluatePermission("memory", { action: "write" }, p)).toBe("approve");
    expect(evaluatePermission("memory", { action: "write", scope: "profile" }, p)).toBe("auto");
    expect(evaluatePermission("memory", { action: "read" }, p)).toBe("auto");
  });

  it("keeps first-match-wins, so a specific rule can precede a catch-all", () => {
    const p = perms([
      { match: { scope: "^global$" }, action: "approve" },
      { match: { scope: null }, action: "approve" },
      { match: {}, action: "auto" },
    ]);

    expect(evaluatePermission("memory", { scope: "global" }, p)).toBe("approve");
    expect(evaluatePermission("memory", {}, p)).toBe("approve");
    expect(evaluatePermission("memory", { scope: "profile" }, p)).toBe("auto");
  });
});
