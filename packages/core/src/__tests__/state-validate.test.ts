/**
 * Schema validation for world-state records.
 *
 * The messages are the product here as much as the verdicts: they go back to
 * a model as the reason a write failed, so each test pins the wording an
 * agent will actually be shown.
 */
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../state/types.js";
import { summarizeFields, unsupportedKeywords, validateAgainstSchema } from "../state/validate.js";

const plan: JsonSchema = {
  type: "object",
  required: ["name", "steps"],
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: 20 },
    status: { type: "string", enum: ["draft", "active", "done"] },
    priority: { type: "integer", minimum: 1, maximum: 5 },
    steps: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" }, done: { type: "boolean" } },
      },
    },
  },
};

describe("validateAgainstSchema", () => {
  it("passes a record that fits", () => {
    expect(
      validateAgainstSchema(plan, { name: "Trip", status: "active", steps: [{ text: "book", done: false }] }),
    ).toEqual([]);
  });

  it("passes anything when there is no schema", () => {
    expect(validateAgainstSchema(undefined, { anything: [1, 2] })).toEqual([]);
  });

  it("names a missing required field", () => {
    expect(validateAgainstSchema(plan, { name: "Trip" })).toEqual(["`steps` is required"]);
  });

  it("lists the allowed values when an enum is missed", () => {
    expect(validateAgainstSchema(plan, { name: "Trip", steps: [], status: "finished" })).toEqual([
      '`status` must be one of: draft, active, done (got "finished")',
    ]);
  });

  it("reports nested and indexed paths", () => {
    expect(validateAgainstSchema(plan, { name: "Trip", steps: [{ text: "a" }, { done: "yes" }] })).toEqual([
      "`steps[1].text` is required",
      '`steps[1].done` must be a boolean (got "yes")',
    ]);
  });

  it("names the real fields when an unknown one is written", () => {
    expect(validateAgainstSchema(plan, { name: "Trip", steps: [], colour: "red" })).toEqual([
      "`colour` is not a field of this type (fields: name, status, priority, steps)",
    ]);
  });

  it("checks whole numbers, bounds, lengths and list sizes", () => {
    const errors = validateAgainstSchema(plan, {
      name: "A name that is far too long",
      priority: 2.5,
      steps: [{ text: "1" }, { text: "2" }, { text: "3" }, { text: "4" }],
    });
    expect(errors).toEqual([
      "`name` must be at most 20 characters (got 27)",
      "`priority` must be a whole number (got number 2.5)",
      "`steps` must have at most 3 item(s) (got 4)",
    ]);
    expect(validateAgainstSchema(plan, { name: "x", priority: 9, steps: [] })).toEqual([
      "`priority` must be at most 5 (got 9)",
    ]);
  });

  it("does not pile further errors onto a value of the wrong type", () => {
    expect(validateAgainstSchema(plan, "not an object")).toEqual(['the data must be an object (got "not an object")']);
  });

  it("treats a pattern that will not compile as no constraint, not a failure", () => {
    expect(validateAgainstSchema({ type: "string", pattern: "([" }, "anything")).toEqual([]);
    expect(validateAgainstSchema({ type: "string", pattern: "^[a-z]+$" }, "ABC")).toEqual([
      "the data must match the pattern ^[a-z]+$",
    ]);
  });
});

describe("unsupportedKeywords", () => {
  it("names keywords core does not enforce, with where they are", () => {
    expect(
      unsupportedKeywords({
        type: "object",
        oneOf: [],
        properties: { when: { type: "string", format: "date-time" }, tags: { type: "array", items: { anyOf: [] } } },
      }),
    ).toEqual(["oneOf", "when: format", "tags[]: anyOf"]);
  });

  it("is empty for the subset it does enforce", () => {
    expect(unsupportedKeywords(plan)).toEqual([]);
  });
});

describe("summarizeFields", () => {
  it("describes fields in one line a model can read", () => {
    expect(summarizeFields(plan)).toBe(
      "name (string, required), status (draft | active | done), priority (integer), steps (list of objects, required)",
    );
  });

  it("says so when a type has no declared fields", () => {
    expect(summarizeFields(undefined)).toBe("any fields");
  });
});
