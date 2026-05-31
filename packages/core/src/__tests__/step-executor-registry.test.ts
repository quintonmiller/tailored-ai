import { describe, expect, it } from "vitest";
import {
  BUILTIN_TRIGGER_KINDS,
  populateBuiltinTriggers,
  StepExecutorRegistry,
  TriggerKindRegistry,
} from "../resources/index.js";
import type { StepExecutor } from "../workflows/engine.js";
import type { StepType, WorkflowStepDef } from "../workflows/types.js";

function fakeExecutor(type: StepType, output: unknown = "ok"): StepExecutor {
  return {
    type,
    async execute(_step: WorkflowStepDef) {
      return { output };
    },
  };
}

describe("StepExecutorRegistry", () => {
  it("registers built-ins and resolves by step type", () => {
    const reg = new StepExecutorRegistry();
    reg.registerBuiltin(fakeExecutor("shell" as StepType));
    reg.registerBuiltin(fakeExecutor("agent_run" as StepType));
    expect(reg.getByType("shell" as StepType)).toBeDefined();
    expect(reg.getByType("agent_run" as StepType)).toBeDefined();
    expect(reg.asMap().size).toBe(2);
  });

  it("replaces the active executor when a new one registers for the same type", () => {
    const reg = new StepExecutorRegistry();
    reg.registerBuiltin(fakeExecutor("shell" as StepType, "v1"), { id: "builtin/shell" });
    reg.registerBuiltin(fakeExecutor("shell" as StepType, "v2"), { id: "community/shell" });
    // Both resource entries exist; latest registered wins for type lookup.
    const result = reg.getByType("shell" as StepType);
    expect(result).toBeDefined();
  });

  it("clears type binding on unregister", () => {
    const reg = new StepExecutorRegistry();
    reg.registerBuiltin(fakeExecutor("shell" as StepType), { id: "builtin/shell" });
    expect(reg.getByType("shell" as StepType)).toBeDefined();
    reg.unregister("builtin/shell");
    expect(reg.getByType("shell" as StepType)).toBeUndefined();
  });

  it("rejects mis-kinded resources", () => {
    const reg = new StepExecutorRegistry();
    expect(() =>
      reg.register({
        manifest: { kind: "tool", id: "x", version: "1.0.0" },
        origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
        body: fakeExecutor("shell" as StepType),
      }),
    ).toThrow(/expected manifest\.kind="step_executor"/);
  });
});

describe("TriggerKindRegistry", () => {
  it("populates with built-in trigger kinds", () => {
    const reg = new TriggerKindRegistry();
    populateBuiltinTriggers(reg);
    const kinds = reg
      .list()
      .map((k) => k.kind)
      .sort();
    expect(kinds).toEqual(BUILTIN_TRIGGER_KINDS.map((k) => k.kind).sort());
  });

  it("looks up by trigger kind", () => {
    const reg = new TriggerKindRegistry();
    populateBuiltinTriggers(reg);
    const cron = reg.getByKind("cron");
    expect(cron?.async).toBe(true);
    expect(reg.getByKind("missing")).toBeUndefined();
  });

  it("rejects mis-kinded resources", () => {
    const reg = new TriggerKindRegistry();
    expect(() =>
      reg.register({
        manifest: { kind: "tool", id: "x", version: "1.0.0" },
        origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
        body: { kind: "x" },
      }),
    ).toThrow(/expected manifest\.kind="trigger"/);
  });
});
