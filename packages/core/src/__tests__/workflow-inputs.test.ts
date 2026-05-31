import { describe, expect, it } from "vitest";
import { validateInputsSchema, validateWorkflowInputs } from "../workflows/inputs.js";

describe("validateWorkflowInputs", () => {
  it("passes through arbitrary payload when no schema is set", () => {
    const r = validateWorkflowInputs(undefined, { anything: "goes" });
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual({ anything: "goes" });
  });

  it("rejects missing required fields", () => {
    const r = validateWorkflowInputs({ name: { type: "string", required: true } }, {});
    expect(r.errors).toEqual(['Missing required input "name"']);
  });

  it("falls back to default when an optional field is missing", () => {
    const r = validateWorkflowInputs({ limit: { type: "number", default: 10 } }, {});
    expect(r.errors).toEqual([]);
    expect(r.values.limit).toBe(10);
  });

  it("coerces numeric strings to numbers and enforces min/max", () => {
    const r = validateWorkflowInputs({ age: { type: "number", min: 0, max: 150 } }, { age: "30" });
    expect(r.errors).toEqual([]);
    expect(r.values.age).toBe(30);

    const bad = validateWorkflowInputs({ age: { type: "number", min: 0, max: 150 } }, { age: "200" });
    expect(bad.errors).toEqual(['Input "age" must be <= 150']);
  });

  it("rejects out-of-enum string fields", () => {
    const r = validateWorkflowInputs({ mode: { type: "string", enum: ["fast", "slow"] } }, { mode: "medium" });
    expect(r.errors).toEqual(['Input "mode" must be one of: fast, slow']);
  });

  it("parses JSON-string body for type: json", () => {
    const r = validateWorkflowInputs({ config: { type: "json" } }, { config: '{"a":1}' });
    expect(r.errors).toEqual([]);
    expect(r.values.config).toEqual({ a: 1 });
  });

  it("coerces 'true'/'false' strings to booleans", () => {
    const r = validateWorkflowInputs({ enabled: { type: "boolean" } }, { enabled: "true" });
    expect(r.values.enabled).toBe(true);
  });

  it("drops unknown payload fields not in the schema", () => {
    const r = validateWorkflowInputs({ keep: { type: "string" } }, { keep: "yes", drop: "this" });
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual({ keep: "yes" });
  });
});

describe("validateInputsSchema", () => {
  it("rejects non-object schemas", () => {
    expect(validateInputsSchema("nope" as unknown).length).toBeGreaterThan(0);
    expect(validateInputsSchema([] as unknown).length).toBeGreaterThan(0);
  });

  it("rejects unknown field types", () => {
    const errs = validateInputsSchema({ name: { type: "uuid" } });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/type must be/);
  });

  it("accepts well-formed schema", () => {
    expect(
      validateInputsSchema({
        amount: { type: "number", min: 0 },
        mode: { type: "string", enum: ["a", "b"] },
      }),
    ).toEqual([]);
  });
});
