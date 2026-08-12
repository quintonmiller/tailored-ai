import { describe, expect, it } from "vitest";
import { mintToken, mintTokens, referencedTokens, substituteTokens } from "../tokens.js";

describe("witness tokens", () => {
  it("mints values a model cannot plausibly emit by chance", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintToken()));
    expect(seen.size).toBe(500);
    for (const token of seen) expect(token).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
  });

  it("omits characters a model would retype wrongly", () => {
    // The point of a witness is that its absence means the agent did not do the
    // task. A `0` returned as `O` would mean the agent did the task and the
    // benchmark said otherwise, which is worse than not checking.
    const joined = Array.from({ length: 200 }, () => mintToken()).join("");
    for (const ambiguous of ["0", "o", "1", "l", "i"]) expect(joined).not.toContain(ambiguous);
  });

  it("substitutes the same value everywhere it appears", () => {
    const tokens = { secret: "abcdefgh" };
    const scenario = {
      message: "tell me {{token:secret}}",
      history: [{ role: "user", content: "the code is {{token:secret}}" }],
      expect: [{ reply_mentions_any: ["{{token:secret}}"] }],
    };
    const out = substituteTokens(scenario, tokens);

    expect(out.message).toBe("tell me abcdefgh");
    expect(out.history[0].content).toBe("the code is abcdefgh");
    expect(out.expect[0].reply_mentions_any).toEqual(["abcdefgh"]);
  });

  it("leaves an unknown name alone rather than blanking it", () => {
    // Blanking would turn `reply_mentions_any: [""]` into an assertion that
    // matches anything — a check that cannot fail, which is the exact failure
    // this whole mechanism exists to remove. Loud beats convenient.
    expect(substituteTokens("{{token:typo}}", { real: "abcdefgh" })).toBe("{{token:typo}}");
  });

  it("finds every name a structure references", () => {
    expect(referencedTokens({ a: "{{token:one}}", b: ["{{token:two}}", { c: "{{token:one}}" }] }).sort()).toEqual([
      "one",
      "two",
    ]);
  });

  it("gives each name its own value", () => {
    const tokens = mintTokens(["alpha", "beta"]);
    expect(tokens.alpha).not.toBe(tokens.beta);
  });
});

describe("witness formats survive being reported back", () => {
  it("keeps a number short enough that a thousands separator cannot split it", () => {
    // `8763` came back as `8,763` and failed a correct agent. Three digits are
    // never split, and stay a substring when the model elaborates.
    for (let i = 0; i < 200; i++) {
      const n = mintToken("number");
      expect(n).toMatch(/^\d{3}$/);
      expect(`${n},000`).toContain(n);
      expect(`${n} thousand`).toContain(n);
    }
  });

  it("mints distinct values within a run", () => {
    // A `day` has 28 values. Two colliding made one scenario assert that a reply
    // both mentions a date and does not — unsatisfiable, and reported as a
    // capability gap.
    for (let i = 0; i < 200; i++) {
      const t = mintTokens({ a: "day", b: "day" });
      expect(t.a).not.toBe(t.b);
    }
  });
});
