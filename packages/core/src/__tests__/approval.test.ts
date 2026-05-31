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
