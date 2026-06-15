import { describe, expect, it } from "vitest";
import { BUILTIN_WIDGET_TYPES, type DashboardWidget, validateDashboardWidget } from "../dashboard/index.js";

describe("validateDashboardWidget", () => {
  it("passes a valid widget", () => {
    expect(validateDashboardWidget({ id: "x", type: "tasks", options: { endpoint: "/api/project-tasks" } })).toEqual(
      [],
    );
  });

  it("flags a missing id", () => {
    expect(validateDashboardWidget({ type: "list" } as DashboardWidget).join()).toMatch(/missing.*`id`/);
  });

  it("flags a missing type", () => {
    expect(validateDashboardWidget({ id: "x" } as DashboardWidget).join()).toMatch(/missing.*`type`/);
  });

  it("warns on an unknown (non-built-in) type", () => {
    expect(validateDashboardWidget({ id: "x", type: "fancy" }).join()).toMatch(/not a built-in renderer/);
  });

  it("accepts an unknown type when it's in the supplied known list", () => {
    expect(validateDashboardWidget({ id: "x", type: "fancy" }, [...BUILTIN_WIDGET_TYPES, "fancy"])).toEqual([]);
  });

  it("flags a span out of range", () => {
    expect(validateDashboardWidget({ id: "x", type: "list", span: 9 }).join()).toMatch(/span/);
  });

  it("rejects a non-/api/ endpoint", () => {
    expect(
      validateDashboardWidget({ id: "x", type: "list", options: { endpoint: "https://evil.example" } }).join(),
    ).toMatch(/same-origin \/api\//);
  });

  it("rejects non-object options", () => {
    expect(
      validateDashboardWidget({ id: "x", type: "list", options: [] as unknown as Record<string, unknown> }).join(),
    ).toMatch(/`options` must be an object/);
  });
});
