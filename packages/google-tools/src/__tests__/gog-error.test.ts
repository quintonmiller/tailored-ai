/**
 * A missing `gog` must not be reported as a Gmail failure.
 *
 * Every tool here reports errors as `stderr || "gog <verb> failed"`. ENOENT
 * produces no stderr, so the fallback fired and the agent was told
 * "gog gmail search failed" — which names the wrong subsystem entirely.
 *
 * In one deployment that cost six days: the first failures genuinely were
 * `oauth2: "invalid_grant"` with gog installed and its token expired. Later the
 * binary went missing, stderr went empty, the message silently changed to the
 * generic one, and five successive diagnoses in the error room kept chasing the
 * token — because nothing ever said the command did not exist.
 */
import { describe, expect, it } from "vitest";
import { gogErrorMessage, spawnFailureReason } from "../gog-error.js";

describe("spawnFailureReason", () => {
  it("names a missing binary and rules out auth", () => {
    const reason = spawnFailureReason({ code: "ENOENT" });

    expect(reason).toMatch(/not installed or not on PATH/);
    // The whole point: stop the reader diagnosing credentials.
    expect(reason).toMatch(/not an authentication problem/i);
  });

  it("distinguishes a non-executable binary from a missing one", () => {
    expect(spawnFailureReason({ code: "EACCES" })).toMatch(/not executable/);
  });

  it("stays quiet for an ordinary non-zero exit", () => {
    // gog ran and failed on its own terms — its stderr is the better message.
    expect(spawnFailureReason({ code: 1 })).toBeUndefined();
    expect(spawnFailureReason(null)).toBeUndefined();
  });
});

describe("gogErrorMessage", () => {
  it("prefers the spawn reason, because stderr is empty in that case", () => {
    const msg = gogErrorMessage(spawnFailureReason({ code: "ENOENT" }), "", "gog gmail search failed");
    expect(msg).toMatch(/not installed/);
    expect(msg).not.toBe("gog gmail search failed");
  });

  it("uses gog's own stderr when it actually ran", () => {
    const msg = gogErrorMessage(undefined, 'oauth2: "invalid_grant" "Bad Request"', "gog gmail search failed");
    expect(msg).toContain("invalid_grant");
  });

  it("falls back only when there is nothing better", () => {
    expect(gogErrorMessage(undefined, "   ", "gog gmail search failed")).toBe("gog gmail search failed");
  });
});
