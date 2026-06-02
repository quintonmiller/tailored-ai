import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkflowsFromDir, parseWorkflow, validateWorkflow } from "../workflows/loader.js";
import { WorkflowRegistry } from "../workflows/registry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseWorkflow", () => {
  it("parses YAML into a workflow definition", () => {
    const wf = parseWorkflow(`
name: hello
steps:
  - name: greet
    type: shell
    command: echo hi
`);
    expect(wf.name).toBe("hello");
    expect(wf.steps).toHaveLength(1);
  });

  it("rejects non-mapping YAML", () => {
    expect(() => parseWorkflow("- 1\n- 2\n")).toThrow(/mapping/);
    expect(() => parseWorkflow("scalar")).toThrow(/mapping/);
  });
});

describe("validateWorkflow", () => {
  it("accepts a minimal valid workflow", () => {
    const errs = validateWorkflow({
      name: "wf1",
      steps: [{ name: "s1", type: "shell", command: "echo hi" }],
    });
    expect(errs).toEqual([]);
  });

  it("requires name and steps", () => {
    expect(validateWorkflow({})).toContain("workflow must have a string `name`");
    expect(validateWorkflow({ name: "x" })).toContain("workflow must have a non-empty `steps` array");
  });

  it("rejects names with invalid characters", () => {
    const errs = validateWorkflow({
      name: "has space",
      steps: [{ name: "s", type: "shell", command: "echo" }],
    });
    expect(errs.some((e) => e.includes(`name "has space"`))).toBe(true);
  });

  it("rejects unknown step types", () => {
    const errs = validateWorkflow({
      name: "wf",
      steps: [{ name: "s1", type: "telepathy" }],
    });
    expect(errs.some((e) => e.includes("not valid"))).toBe(true);
  });

  it("rejects duplicate step names within the same scope", () => {
    const errs = validateWorkflow({
      name: "wf",
      steps: [
        { name: "dup", type: "shell", command: "a" },
        { name: "dup", type: "shell", command: "b" },
      ],
    });
    expect(errs.some((e) => e.includes("duplicated"))).toBe(true);
  });

  it("allows duplicate names across nested scopes", () => {
    const errs = validateWorkflow({
      name: "wf",
      steps: [
        {
          name: "outer",
          type: "loop",
          over: "${input.items}",
          as: "x",
          body: [{ name: "iter", type: "shell", command: "echo" }],
        },
        {
          name: "iter",
          type: "shell",
          command: "echo",
        },
      ],
    });
    expect(errs).toEqual([]);
  });

  it("validates type-specific required fields", () => {
    expect(validateWorkflow({ name: "wf", steps: [{ name: "s", type: "agent_run" }] })).toEqual(
      expect.arrayContaining(["steps[0].agent is required for agent_run", "steps[0].prompt is required for agent_run"]),
    );
    expect(validateWorkflow({ name: "wf", steps: [{ name: "s", type: "tool_call" }] })).toContain(
      "steps[0].tool is required for tool_call",
    );
    expect(validateWorkflow({ name: "wf", steps: [{ name: "s", type: "shell" }] })).toContain(
      "steps[0].command is required for shell",
    );
    expect(validateWorkflow({ name: "wf", steps: [{ name: "s", type: "condition" }] })).toContain(
      "steps[0].if is required for condition",
    );
    expect(validateWorkflow({ name: "wf", steps: [{ name: "s", type: "loop" }] })).toEqual(
      expect.arrayContaining(["steps[0].over is required for loop", "steps[0].as is required for loop"]),
    );
  });

  describe("triggers", () => {
    const wf = (kind: string, extra: Record<string, unknown> = {}) => ({
      name: "wf",
      steps: [{ name: "s", type: "shell", command: "echo" }],
      triggers: [{ kind, ...extra }],
    });

    it("accepts every built-in trigger kind", () => {
      // The kinds the loader used to hard-reject before the registry-driven
      // validation fix (#54). Each needs its required-fields satisfied where
      // the kind has a sub-validator.
      const cases: Array<[string, Record<string, unknown>]> = [
        ["manual", {}],
        ["cron", { schedule: "0 * * * *" }],
        ["webhook", {}],
        ["tool_called", { tool: "read" }],
        ["document_event", { events: ["created"] }],
        ["config_event", {}],
        ["file_drop", { path: "/tmp/incoming" }],
        ["email_message", { query: "newer_than:1d" }],
        ["calendar_event", {}],
        ["rss", { url: "https://example.com/feed" }],
        ["geofence", {}],
        ["weather", {}],
        ["sensor", {}],
        ["finance", {}],
        ["home_assistant", {}],
      ];
      for (const [kind, extra] of cases) {
        expect(validateWorkflow(wf(kind, extra)), `kind=${kind}`).toEqual([]);
      }
    });

    it("rejects unknown trigger kinds with a helpful enumeration", () => {
      const errs = validateWorkflow(wf("telepathy"));
      expect(errs.some((e) => e.includes("telepathy") || e.includes("triggers[0].kind"))).toBe(true);
      const err = errs.find((e) => e.startsWith("triggers[0].kind"))!;
      // Both the historical kinds AND the previously-rejected ones should be
      // listed in the must-be-one-of message.
      expect(err).toContain("cron");
      expect(err).toContain("geofence");
      expect(err).toContain("weather");
      expect(err).toContain("home_assistant");
    });

    it("accepts plugin-supplied trigger kinds via allowedTriggerKinds", () => {
      const errs = validateWorkflow(wf("custom_plugin_kind"), {
        allowedTriggerKinds: ["custom_plugin_kind"],
      });
      expect(errs).toEqual([]);
    });
  });

  it("rejects invalid onError policy", () => {
    const errs = validateWorkflow({
      name: "wf",
      steps: [{ name: "s", type: "shell", command: "echo", onError: "explode" }],
    });
    expect(errs.some((e) => e.includes("onError"))).toBe(true);
  });

  it("validates retry policy", () => {
    const errs = validateWorkflow({
      name: "wf",
      steps: [
        {
          name: "s",
          type: "shell",
          command: "echo",
          retry: { maxAttempts: 0, backoffMs: -1 },
        },
      ],
    });
    expect(errs.some((e) => e.includes("maxAttempts"))).toBe(true);
    expect(errs.some((e) => e.includes("backoffMs"))).toBe(true);
  });

  it("recursively validates loop body and parallel children", () => {
    const errs = validateWorkflow({
      name: "wf",
      steps: [
        {
          name: "p",
          type: "parallel",
          steps: [
            { name: "good", type: "shell", command: "echo" },
            { name: "bad", type: "tool_call" }, // missing tool
          ],
        },
      ],
    });
    expect(errs.some((e) => e.includes("steps[0].steps[1].tool"))).toBe(true);
  });
});

describe("loadWorkflowsFromDir", () => {
  it("returns empty result when directory does not exist", () => {
    const result = loadWorkflowsFromDir(join(dir, "missing"));
    expect(result.workflows).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("loads multiple workflows from .yaml and .yml files", () => {
    writeFileSync(join(dir, "a.yaml"), "name: alpha\nsteps:\n  - name: s\n    type: shell\n    command: echo a\n");
    writeFileSync(join(dir, "b.yml"), "name: beta\nsteps:\n  - name: s\n    type: shell\n    command: echo b\n");
    writeFileSync(join(dir, "ignored.txt"), "not a workflow");
    const result = loadWorkflowsFromDir(dir);
    expect(result.workflows.map((w) => w.name).sort()).toEqual(["alpha", "beta"]);
    expect(result.errors).toEqual([]);
  });

  it("collects validation errors per file", () => {
    writeFileSync(join(dir, "ok.yaml"), "name: ok\nsteps:\n  - name: s\n    type: shell\n    command: e\n");
    writeFileSync(join(dir, "bad.yaml"), "name: bad\nsteps: []\n");
    const result = loadWorkflowsFromDir(dir);
    expect(result.workflows.map((w) => w.name)).toEqual(["ok"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path.endsWith("bad.yaml")).toBe(true);
    expect(result.errors[0].error).toContain("non-empty `steps`");
  });

  it("collects parse errors", () => {
    writeFileSync(join(dir, "broken.yaml"), "name: : :\n  - bad");
    const result = loadWorkflowsFromDir(dir);
    expect(result.errors).toHaveLength(1);
  });
});

describe("WorkflowRegistry", () => {
  it("loads from disk and looks up by name", () => {
    writeFileSync(join(dir, "wf.yaml"), "name: my-wf\nsteps:\n  - name: s\n    type: shell\n    command: echo\n");
    const reg = new WorkflowRegistry();
    reg.setDirectory(dir);
    reg.reloadFromDisk();
    expect(reg.get("my-wf")?.definition.name).toBe("my-wf");
    expect(reg.list()).toHaveLength(1);
  });

  it("programmatic registrations override file workflows", () => {
    writeFileSync(join(dir, "wf.yaml"), "name: shared\nsteps:\n  - name: s\n    type: shell\n    command: from-disk\n");
    const reg = new WorkflowRegistry();
    reg.setDirectory(dir);
    reg.reloadFromDisk();
    reg.register({
      name: "shared",
      steps: [{ name: "s", type: "shell", command: "from-code" }],
    });
    const wf = reg.get("shared");
    expect(wf?.source).toBe("programmatic");
    expect((wf?.definition.steps[0] as { command: string }).command).toBe("from-code");
  });

  it("reloadFromDisk preserves programmatic workflows", () => {
    const reg = new WorkflowRegistry();
    reg.setDirectory(dir);
    reg.register({
      name: "code-only",
      steps: [{ name: "s", type: "shell", command: "echo" }],
    });
    reg.reloadFromDisk();
    expect(reg.get("code-only")).toBeDefined();
  });

  it("unregister removes programmatic workflows", () => {
    const reg = new WorkflowRegistry();
    reg.register({
      name: "tmp",
      steps: [{ name: "s", type: "shell", command: "echo" }],
    });
    expect(reg.unregister("tmp")).toBe(true);
    expect(reg.unregister("tmp")).toBe(false);
    expect(reg.get("tmp")).toBeUndefined();
  });

  it("notifies onChange listeners", () => {
    const reg = new WorkflowRegistry();
    let calls = 0;
    reg.onChange(() => {
      calls++;
    });
    reg.register({
      name: "x",
      steps: [{ name: "s", type: "shell", command: "echo" }],
    });
    reg.unregister("x");
    expect(calls).toBe(2);
  });

  it("exposes load errors via getErrors", () => {
    writeFileSync(join(dir, "bad.yaml"), "name: bad\nsteps: []\n");
    const reg = new WorkflowRegistry();
    reg.setDirectory(dir);
    reg.reloadFromDisk();
    expect(reg.getErrors()).toHaveLength(1);
  });
});
