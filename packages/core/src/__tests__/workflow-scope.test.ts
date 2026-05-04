import { describe, expect, it } from "vitest";
import { lookup, resolveString, resolveValue, type Scope } from "../workflows/scope.js";

const scope: Scope = {
  input: { url: "https://example.com", tasks: [{ id: 1 }, { id: 2 }] },
  steps: { research: "the answer", count: 42 },
  prev: "previous",
  env: { HOME: "/home/x" },
  vars: { item: { id: 99, label: "loop-item" } },
};

describe("lookup", () => {
  it("resolves dotted paths in input/steps/prev/env", () => {
    expect(lookup("input.url", scope)).toBe("https://example.com");
    expect(lookup("steps.research", scope)).toBe("the answer");
    expect(lookup("steps.count", scope)).toBe(42);
    expect(lookup("prev", scope)).toBe("previous");
    expect(lookup("env.HOME", scope)).toBe("/home/x");
  });

  it("supports bracket indexing", () => {
    expect(lookup("input.tasks[0].id", scope)).toBe(1);
    expect(lookup("input.tasks[1].id", scope)).toBe(2);
  });

  it("resolves loop bindings via vars", () => {
    expect(lookup("item.id", scope)).toBe(99);
  });

  it("returns undefined for unknown roots", () => {
    expect(lookup("missing.key", scope)).toBeUndefined();
  });
});

describe("resolveString", () => {
  it("interpolates ${...} into a string", () => {
    expect(resolveString("URL: ${input.url}", scope)).toBe("URL: https://example.com");
  });

  it("preserves type when entire string is a single ${...}", () => {
    expect(resolveString("${input.tasks}", scope)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(resolveString("${steps.count}", scope)).toBe(42);
  });

  it("renders missing references as empty strings (interpolation form)", () => {
    expect(resolveString("X=${missing.x};", scope)).toBe("X=;");
  });

  it("JSON-stringifies object values in interpolation", () => {
    expect(resolveString("data=${input.tasks[0]}", scope)).toBe('data={"id":1}');
  });
});

describe("resolveValue", () => {
  it("recurses through arrays and objects", () => {
    const value = {
      url: "${input.url}",
      ids: ["${input.tasks[0].id}", "${input.tasks[1].id}"],
      static: 7,
    };
    expect(resolveValue(value, scope)).toEqual({
      url: "https://example.com",
      ids: [1, 2],
      static: 7,
    });
  });
});
