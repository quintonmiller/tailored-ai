import { describe, expect, it } from "vitest";
import {
  ActionTier,
  ActionRegistry,
  createDefaultRegistry,
  classifyAction,
  registerAction,
} from "../action-tiers.js";

describe("ActionTier enum", () => {
  it("has all four tier values", () => {
    expect(ActionTier.Green).toBe("green");
    expect(ActionTier.Yellow).toBe("yellow");
    expect(ActionTier.Red).toBe("red");
    expect(ActionTier.Black).toBe("black");
  });
});

describe("ActionRegistry", () => {
  it("starts empty", () => {
    const registry = new ActionRegistry();
    expect(registry.classifyAction("anything")).toBeUndefined();
    expect(registry.listActions()).toEqual([]);
  });

  it("registers and classifies a single action", () => {
    const registry = new ActionRegistry();
    registry.register("test_action", {
      description: "A test action",
      tier: ActionTier.Green,
    });

    expect(registry.classifyAction("test_action")).toBe(ActionTier.Green);
    expect(registry.get("test_action")?.description).toBe("A test action");
  });

  it("registers many actions at once", () => {
    const registry = new ActionRegistry();
    registry.registerMany({
      action_a: { description: "A", tier: ActionTier.Green },
      action_b: { description: "B", tier: ActionTier.Yellow },
      action_c: { description: "C", tier: ActionTier.Red },
      action_d: { description: "D", tier: ActionTier.Black },
    });

    expect(registry.classifyAction("action_a")).toBe(ActionTier.Green);
    expect(registry.classifyAction("action_b")).toBe(ActionTier.Yellow);
    expect(registry.classifyAction("action_c")).toBe(ActionTier.Red);
    expect(registry.classifyAction("action_d")).toBe(ActionTier.Black);
  });

  it("returns undefined for unregistered actions", () => {
    const registry = new ActionRegistry();
    registry.register("known", { description: "known", tier: ActionTier.Green });
    expect(registry.classifyAction("unknown")).toBeUndefined();
  });

  it("isAllowed returns false only for black tier", () => {
    const registry = new ActionRegistry();
    registry.registerMany({
      green_act: { description: "g", tier: ActionTier.Green },
      yellow_act: { description: "y", tier: ActionTier.Yellow },
      red_act: { description: "r", tier: ActionTier.Red },
      black_act: { description: "b", tier: ActionTier.Black },
    });

    expect(registry.isAllowed("green_act")).toBe(true);
    expect(registry.isAllowed("yellow_act")).toBe(true);
    expect(registry.isAllowed("red_act")).toBe(true);
    expect(registry.isAllowed("black_act")).toBe(false);
    expect(registry.isAllowed("unknown")).toBe(false); // undefined !== Black, but isAllowed checks !== Black
  });

  it("requiresApproval returns true only for red tier", () => {
    const registry = new ActionRegistry();
    registry.registerMany({
      green_act: { description: "g", tier: ActionTier.Green },
      red_act: { description: "r", tier: ActionTier.Red },
      black_act: { description: "b", tier: ActionTier.Black },
    });

    expect(registry.requiresApproval("green_act")).toBe(false);
    expect(registry.requiresApproval("red_act")).toBe(true);
    expect(registry.requiresApproval("black_act")).toBe(false);
  });

  it("isAutoApproved returns true only for green tier", () => {
    const registry = new ActionRegistry();
    registry.registerMany({
      green_act: { description: "g", tier: ActionTier.Green },
      yellow_act: { description: "y", tier: ActionTier.Yellow },
      red_act: { description: "r", tier: ActionTier.Red },
    });

    expect(registry.isAutoApproved("green_act")).toBe(true);
    expect(registry.isAutoApproved("yellow_act")).toBe(false);
    expect(registry.isAutoApproved("red_act")).toBe(false);
  });

  it("actionsByTier filters correctly", () => {
    const registry = new ActionRegistry();
    registry.registerMany({
      a: { description: "a", tier: ActionTier.Green },
      b: { description: "b", tier: ActionTier.Green },
      c: { description: "c", tier: ActionTier.Red },
    });

    const greens = registry.actionsByTier(ActionTier.Green);
    expect(greens.size).toBe(2);
    expect(greens.has("a")).toBe(true);
    expect(greens.has("b")).toBe(true);
    expect(greens.has("c")).toBe(false);

    const reds = registry.actionsByTier(ActionTier.Red);
    expect(reds.size).toBe(1);
    expect(reds.has("c")).toBe(true);
  });

  it("listActions returns all registered names", () => {
    const registry = new ActionRegistry();
    registry.registerMany({
      x: { description: "x", tier: ActionTier.Green },
      y: { description: "y", tier: ActionTier.Yellow },
    });

    const names = registry.listActions();
    expect(names).toContain("x");
    expect(names).toContain("y");
    expect(names.length).toBe(2);
  });
});

describe("createDefaultRegistry", () => {
  it("has green actions", () => {
    const registry = createDefaultRegistry();
    expect(registry.classifyAction("read_config")).toBe(ActionTier.Green);
    expect(registry.classifyAction("list_tools")).toBe(ActionTier.Green);
    expect(registry.classifyAction("read_file")).toBe(ActionTier.Green);
  });

  it("has yellow actions", () => {
    const registry = createDefaultRegistry();
    expect(registry.classifyAction("update_task_status")).toBe(ActionTier.Yellow);
    expect(registry.classifyAction("write_note")).toBe(ActionTier.Yellow);
  });

  it("has red actions", () => {
    const registry = createDefaultRegistry();
    expect(registry.classifyAction("create_agent")).toBe(ActionTier.Red);
    expect(registry.classifyAction("update_permissions")).toBe(ActionTier.Red);
    expect(registry.classifyAction("install_resource")).toBe(ActionTier.Red);
  });

  it("has black actions", () => {
    const registry = createDefaultRegistry();
    expect(registry.classifyAction("modify_self_policy")).toBe(ActionTier.Black);
    expect(registry.classifyAction("disable_security")).toBe(ActionTier.Black);
    expect(registry.classifyAction("modify_tier_definitions")).toBe(ActionTier.Black);
  });

  it("has all four tiers represented", () => {
    const registry = createDefaultRegistry();
    expect(registry.actionsByTier(ActionTier.Green).size).toBeGreaterThan(0);
    expect(registry.actionsByTier(ActionTier.Yellow).size).toBeGreaterThan(0);
    expect(registry.actionsByTier(ActionTier.Red).size).toBeGreaterThan(0);
    expect(registry.actionsByTier(ActionTier.Black).size).toBeGreaterThan(0);
  });
});

describe("standalone helpers", () => {
  it("classifyAction uses the default registry", () => {
    expect(classifyAction("read_config")).toBe(ActionTier.Green);
    expect(classifyAction("create_agent")).toBe(ActionTier.Red);
    expect(classifyAction("modify_self_policy")).toBe(ActionTier.Black);
    expect(classifyAction("nonexistent")).toBeUndefined();
  });

  it("registerAction adds to the default registry", () => {
    registerAction("custom_test_action", {
      description: "A custom test action",
      tier: ActionTier.Yellow,
    });

    expect(classifyAction("custom_test_action")).toBe(ActionTier.Yellow);
  });
});
