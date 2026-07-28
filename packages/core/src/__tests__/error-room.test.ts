import { describe, expect, it } from "vitest";
import { errorSignature, redactSecrets } from "../plugins/error-room.js";

describe("redactSecrets", () => {
  it("redacts credential-shaped values before they leave the process", () => {
    // A token posted to a channel is a token you have to rotate.
    expect(redactSecrets("token: MTQ2NzM4NjU3OTEyNjQ1NjQ2NQ.G0_rbx.HUrW7iw4G4A2IZ")).toBe("token: [redacted]");
    expect(redactSecrets("api_key=sk-abcdef123456")).toBe("api_key=[redacted]");
    expect(redactSecrets("Authorization: Bearer eyJhbGciOi.abc")).toContain("[redacted]");
  });

  it("redacts a bare JWT-shaped string", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u";
    expect(redactSecrets(`failed with ${jwt}`)).toBe("failed with [redacted]");
  });

  it("leaves an ordinary error message readable", () => {
    const msg = "ls: cannot access '/home/quint/research': No such file or directory";
    expect(redactSecrets(msg)).toBe(msg);
  });
});

describe("errorSignature", () => {
  it("treats the same failure with different ids as one thing", () => {
    // Otherwise a per-task failure reports once per task and floods the room.
    expect(errorSignature("task ptask_11 failed")).toBe(errorSignature("task ptask_22 failed"));
  });

  it("keeps genuinely different failures apart", () => {
    expect(errorSignature("provider timed out")).not.toBe(errorSignature("disk full"));
  });

  it("is bounded, so a stack trace cannot become the key", () => {
    expect(errorSignature("x".repeat(5000)).length).toBeLessThanOrEqual(200);
  });
});
