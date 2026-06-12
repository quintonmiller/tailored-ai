/**
 * Tests for the inverted workflow executor construction path (#62):
 * built-in executors register factories into StepExecutorRegistry;
 * createWorkflowEngine iterates the registry instead of a hardcoded array.
 */

import { describe, expect, it, vi } from "vitest";
import {
  type StepExecutorContext,
  type StepExecutorFactory,
  StepExecutorRegistry,
} from "../resources/step-executor-registry.js";
import { populateBuiltinExecutors } from "../workflows/builtin-executors.js";
import type { StepExecutor } from "../workflows/engine.js";
import type { StepType, WorkflowStepDef } from "../workflows/types.js";

const EXPECTED_BUILTIN_TYPES = [
  "agent_run",
  "tool_call",
  "shell",
  "worktree",
  "loop",
  "parallel",
  "channel_message",
  "trigger_workflow",
  "http_request",
  "notify",
] as const;

function fakeRuntime() {
  return {
    getTools: () => [],
    getConfig: () => ({ security: {} }),
    resolveOutbound: () => undefined,
    getOwnerId: () => undefined,
  } as unknown as import("../runtime.js").AgentRuntime;
}

function fakeCtx(): StepExecutorContext {
  const runtime = fakeRuntime();
  return {
    runtime,
    db: {} as import("better-sqlite3").Database,
    resolveOutbound: () => undefined,
    getOwnerId: () => undefined,
  };
}

function fakeExecutor(type: string): StepExecutor {
  return {
    type: type as StepType,
    async execute(_step: WorkflowStepDef) {
      return { output: "ok" };
    },
  };
}

describe("populateBuiltinExecutors", () => {
  it("registers a factory for every built-in step type", () => {
    const reg = new StepExecutorRegistry();
    populateBuiltinExecutors(reg);
    const executors = reg.buildAll(fakeCtx());
    const types = executors.map((e) => e.type).sort();
    for (const expected of EXPECTED_BUILTIN_TYPES) {
      expect(types).toContain(expected);
    }
  });

  it("is idempotent — calling twice does not double-register", () => {
    const reg = new StepExecutorRegistry();
    populateBuiltinExecutors(reg);
    populateBuiltinExecutors(reg);
    const executors = reg.buildAll(fakeCtx());
    // No duplicates: each type should appear exactly once.
    const types = executors.map((e) => e.type);
    const unique = new Set(types);
    expect(types.length).toBe(unique.size);
  });
});

describe("StepExecutorRegistry factory registration", () => {
  it("registerBuiltinFactory installs a callable factory", () => {
    const reg = new StepExecutorRegistry();
    const factory: StepExecutorFactory = () => fakeExecutor("shell");
    reg.registerBuiltinFactory("shell", factory);
    const executors = reg.buildAll(fakeCtx());
    expect(executors).toHaveLength(1);
    expect(executors[0].type).toBe("shell");
  });

  it("registerFactory (plugin path) also produces an executor via buildAll", () => {
    const reg = new StepExecutorRegistry();
    const factory: StepExecutorFactory = () => fakeExecutor("my_custom_step");
    reg.registerFactory("my_custom_step", factory);
    const executors = reg.buildAll(fakeCtx());
    expect(executors.map((e) => e.type)).toContain("my_custom_step");
  });

  it("plugin factory overrides a built-in type when registered for the same type", () => {
    const reg = new StepExecutorRegistry();
    populateBuiltinExecutors(reg);

    const customShell = fakeExecutor("shell");
    const spy = vi.fn(() => customShell);
    reg.registerFactory("shell", spy);

    const executors = reg.buildAll(fakeCtx());
    // Should still have exactly one shell executor, and it's ours.
    const shellExecs = executors.filter((e) => e.type === "shell");
    expect(shellExecs).toHaveLength(1);
    expect(shellExecs[0]).toBe(customShell);
    expect(spy).toHaveBeenCalled();
  });

  it("factory receives the StepExecutorContext", () => {
    const reg = new StepExecutorRegistry();
    const receivedCtx: StepExecutorContext[] = [];
    const factory: StepExecutorFactory = (ctx) => {
      receivedCtx.push(ctx);
      return fakeExecutor("test_step");
    };
    reg.registerBuiltinFactory("test_step", factory);

    const ctx = fakeCtx();
    reg.buildAll(ctx);
    expect(receivedCtx).toHaveLength(1);
    expect(receivedCtx[0]).toBe(ctx);
  });

  it("re-registering a builtin factory for the same type is a no-op (first wins, no duplicate)", () => {
    const reg = new StepExecutorRegistry();
    const v1 = vi.fn(() => fakeExecutor("shell"));
    const v2 = vi.fn(() => fakeExecutor("shell"));

    reg.registerBuiltinFactory("shell", v1);
    reg.registerBuiltinFactory("shell", v2); // no-op: hot-reload re-populate

    const executors = reg.buildAll(fakeCtx());
    expect(executors.filter((e) => e.type === "shell")).toHaveLength(1);
    expect(v1).toHaveBeenCalled();
    expect(v2).not.toHaveBeenCalled();
  });

  it("a plugin override of a builtin type survives builtin re-population", () => {
    const reg = new StepExecutorRegistry();
    const builtin = vi.fn(() => fakeExecutor("shell"));
    const plugin = vi.fn(() => fakeExecutor("shell"));

    reg.registerBuiltinFactory("shell", builtin);
    reg.registerFactory("shell", plugin); // plugin overrides built-in
    reg.registerBuiltinFactory("shell", builtin); // hot-reload re-populate

    const executors = reg.buildAll(fakeCtx());
    expect(executors.filter((e) => e.type === "shell")).toHaveLength(1);
    expect(plugin).toHaveBeenCalled();
    expect(builtin).not.toHaveBeenCalled();
  });

  it("all built-in factories produce executors with the correct type", () => {
    const reg = new StepExecutorRegistry();
    populateBuiltinExecutors(reg);
    const ctx = fakeCtx();
    const executors = reg.buildAll(ctx);
    for (const exec of executors) {
      expect(typeof exec.type).toBe("string");
      expect(exec.type.length).toBeGreaterThan(0);
      expect(typeof exec.execute).toBe("function");
    }
  });
});
