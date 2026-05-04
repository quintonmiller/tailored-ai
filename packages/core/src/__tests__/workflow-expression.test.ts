import { describe, expect, it } from "vitest";
import { evaluateExpression } from "../workflows/expression.js";
import type { Scope } from "../workflows/scope.js";

const scope: Scope = {
  input: { count: 3, name: "alpha" },
  steps: { tests: { exitCode: 0 }, build: { ok: true } },
  env: { CI: "1" },
};

describe("evaluateExpression", () => {
  it("evaluates literal booleans and not", () => {
    expect(evaluateExpression("true", scope)).toBe(true);
    expect(evaluateExpression("false", scope)).toBe(false);
    expect(evaluateExpression("!true", scope)).toBe(false);
    expect(evaluateExpression("!!true", scope)).toBe(true);
  });

  it("evaluates && and || with short-circuit", () => {
    expect(evaluateExpression("true && false", scope)).toBe(false);
    expect(evaluateExpression("true || false", scope)).toBe(true);
    expect(evaluateExpression("(true || false) && true", scope)).toBe(true);
  });

  it("evaluates equality with type-loose comparison", () => {
    expect(evaluateExpression("${steps.tests.exitCode} == 0", scope)).toBe(true);
    expect(evaluateExpression("${steps.tests.exitCode} == 1", scope)).toBe(false);
    expect(evaluateExpression('${input.name} == "alpha"', scope)).toBe(true);
    expect(evaluateExpression('${input.name} != "beta"', scope)).toBe(true);
  });

  it("evaluates numeric inequality operators", () => {
    expect(evaluateExpression("${input.count} > 1", scope)).toBe(true);
    expect(evaluateExpression("${input.count} >= 3", scope)).toBe(true);
    expect(evaluateExpression("${input.count} < 1", scope)).toBe(false);
    expect(evaluateExpression("${input.count} <= 3", scope)).toBe(true);
  });

  it("treats missing references as null", () => {
    expect(evaluateExpression("${missing.thing} == null", scope)).toBe(true);
    expect(evaluateExpression('${missing.thing} == "x"', scope)).toBe(false);
  });

  it("supports parentheses for grouping", () => {
    expect(
      evaluateExpression("(${input.count} == 3) && (${steps.build.ok} == true)", scope),
    ).toBe(true);
  });

  it("rejects malformed expressions", () => {
    expect(() => evaluateExpression("&&", scope)).toThrow();
    expect(() => evaluateExpression("${missing", scope)).toThrow();
    expect(() => evaluateExpression("'unterminated", scope)).toThrow();
  });
});
