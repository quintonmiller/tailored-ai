import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_SYSTEM_PROMPT } from "../agent/prompt.js";
import {
  type BuiltInLayers,
  composeSystemPrompt,
  DEFAULT_LAYER_ORDER,
  resolveBase,
  resolveCustomLayers,
} from "../agent/system-prompt.js";

const layers: BuiltInLayers = {
  instructions: "[inst]",
  context: "[ctx]",
  skill_catalog: "[cat]",
  core_memory: "[core]",
  chat_live_state: "[live]",
  recall_memory: "[recall]",
};

describe("system-prompt composer", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns default order when no override given", () => {
    const out = composeSystemPrompt("[base]", layers, undefined, {});
    expect(out).toBe("[base][inst][ctx][cat][core][live][recall]");
  });

  it("uses default base when override is undefined", () => {
    expect(resolveBase(undefined)).toBe(BASE_SYSTEM_PROMPT);
  });

  it("replaces base via inline string", () => {
    expect(resolveBase({ base: "custom-base" })).toBe("custom-base");
  });

  it("replaces base via file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sysprompt-"));
    const file = join(dir, "base.md");
    writeFileSync(file, "from-file");
    try {
      expect(resolveBase({ baseFile: file })).toBe("from-file");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to default base when baseFile is missing", () => {
    expect(resolveBase({ baseFile: "/no/such/file.md" })).toBe(BASE_SYSTEM_PROMPT);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("baseFile"));
  });

  it("inline base takes precedence over baseFile", () => {
    expect(resolveBase({ base: "inline", baseFile: "/no/such" })).toBe("inline");
  });

  it("reorders layers", () => {
    const out = composeSystemPrompt("[base]", layers, { order: ["recall_memory", "base", "instructions"] }, {});
    expect(out).toBe("[recall][base][inst]");
  });

  it("strips layers by omission", () => {
    const out = composeSystemPrompt("[base]", layers, { order: ["base", "instructions"] }, {});
    expect(out).toBe("[base][inst]");
  });

  it("warns on unknown layer names in order", () => {
    composeSystemPrompt("[base]", layers, { order: ["base", "ghost"] }, {});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`Unknown layer "ghost"`));
  });

  it("warns and dedupes when order has duplicate layer names", () => {
    const out = composeSystemPrompt("[base]", layers, { order: ["base", "base"] }, {});
    expect(out).toBe("[base]");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Duplicate"));
  });

  it("injects custom layers when referenced in order", () => {
    const custom = resolveCustomLayers([{ name: "sprint_goals", content: "[goals]" }]);
    const out = composeSystemPrompt(
      "[base]",
      layers,
      { order: ["base", "sprint_goals", "instructions"], custom: [{ name: "sprint_goals", content: "[goals]" }] },
      custom,
    );
    expect(out).toBe("[base][goals][inst]");
  });

  it("loads custom layer content from file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sysprompt-"));
    const file = join(dir, "extra.md");
    writeFileSync(file, "from-disk");
    try {
      const custom = resolveCustomLayers([{ name: "extra", file }]);
      expect(custom).toEqual({ extra: "from-disk" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects custom layer names that collide with built-ins", () => {
    const custom = resolveCustomLayers([{ name: "base", content: "hijack" }]);
    expect(custom).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("collides"));
  });

  it("custom layer with missing file yields empty content + warning", () => {
    const custom = resolveCustomLayers([{ name: "x", file: "/no/such" }]);
    expect(custom).toEqual({ x: "" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`file "/no/such" not found`));
  });

  it("DEFAULT_LAYER_ORDER matches the seven historical layers", () => {
    expect(DEFAULT_LAYER_ORDER).toEqual([
      "base",
      "instructions",
      "context",
      "skill_catalog",
      "core_memory",
      "chat_live_state",
      "recall_memory",
    ]);
  });
});
