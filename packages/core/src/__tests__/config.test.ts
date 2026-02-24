import { describe, expect, it } from "vitest";
import { deepInterpolate, deepMerge } from "../config.js";

describe("deepMerge", () => {
  it("merges flat objects", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("deep merges nested objects", () => {
    const target = { server: { port: 3000, host: "0.0.0.0" } };
    const source = { server: { port: 8080 } };
    const result = deepMerge(
      target as unknown as Record<string, unknown>,
      source as unknown as Record<string, unknown>,
    );
    expect(result).toEqual({ server: { port: 8080, host: "0.0.0.0" } });
  });

  it("does not merge arrays — source replaces target", () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [4, 5] };
    const result = deepMerge(
      target as unknown as Record<string, unknown>,
      source as unknown as Record<string, unknown>,
    );
    expect(result).toEqual({ items: [4, 5] });
  });

  it("does not mutate target", () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    deepMerge(target as unknown as Record<string, unknown>, source as unknown as Record<string, unknown>);
    expect(target).toEqual({ a: { b: 1 } });
  });

  it("handles empty source", () => {
    const target = { a: 1 };
    const result = deepMerge(target as unknown as Record<string, unknown>, {});
    expect(result).toEqual({ a: 1 });
  });
});

describe("deepInterpolate", () => {
  it("interpolates environment variables in strings", () => {
    process.env.TEST_VAR = "hello";
    const result = deepInterpolate("Value: ${TEST_VAR}");
    expect(result).toBe("Value: hello");
    delete process.env.TEST_VAR;
  });

  it("replaces missing env vars with empty string", () => {
    delete process.env.NONEXISTENT_VAR;
    const result = deepInterpolate("${NONEXISTENT_VAR}");
    expect(result).toBe("");
  });

  it("interpolates nested objects", () => {
    process.env.TEST_PORT = "8080";
    const result = deepInterpolate({ server: { port: "${TEST_PORT}" } });
    expect(result).toEqual({ server: { port: "8080" } });
    delete process.env.TEST_PORT;
  });

  it("interpolates arrays", () => {
    process.env.TEST_ITEM = "foo";
    const result = deepInterpolate(["${TEST_ITEM}", "bar"]);
    expect(result).toEqual(["foo", "bar"]);
    delete process.env.TEST_ITEM;
  });

  it("passes through non-string primitives", () => {
    expect(deepInterpolate(42)).toBe(42);
    expect(deepInterpolate(true)).toBe(true);
    expect(deepInterpolate(null)).toBe(null);
  });
});
