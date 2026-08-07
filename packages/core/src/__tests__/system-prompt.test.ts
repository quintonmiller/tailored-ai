import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_SYSTEM_PROMPT } from "../agent/prompt.js";
import {
  type BuiltInLayers,
  composeSystemPrompt,
  composeTailBlock,
  DEFAULT_LAYER_ORDER,
  DEFAULT_TAIL_LAYERS,
  mergeSystemPromptOverrides,
  resetSystemPromptWarnings,
  resolveBase,
  resolveCustomLayers,
  resolveTailLayers,
} from "../agent/system-prompt.js";

const layers: BuiltInLayers = {
  instructions: "[inst]",
  context: "[ctx]",
  skill_catalog: "[cat]",
  core_memory: "[core]",
  chat_live_state: "[live]",
  recall_memory: "[recall]",
  slots_standing: "[slots-standing]",
  slots_state: "[slots-state]",
};

describe("system-prompt composer", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetSystemPromptWarnings();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns default order when no override given, less the tail layers", () => {
    const out = composeSystemPrompt("[base]", layers, undefined, {});
    expect(out).toBe("[base][inst][ctx][cat][slots-standing][core]");
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

  describe("mergeSystemPromptOverrides", () => {
    it("returns undefined when both inputs are undefined", () => {
      expect(mergeSystemPromptOverrides(undefined, undefined)).toBeUndefined();
    });

    it("returns the only side when one is undefined", () => {
      const g = { base: "g" };
      const a = { base: "a" };
      expect(mergeSystemPromptOverrides(g, undefined)).toEqual(g);
      expect(mergeSystemPromptOverrides(undefined, a)).toEqual(a);
    });

    it("per-agent base wins over global base", () => {
      const out = mergeSystemPromptOverrides({ base: "g" }, { base: "a" });
      expect(out).toEqual({ base: "a" });
    });

    it("per-agent baseFile wins over global base (and replaces it)", () => {
      const out = mergeSystemPromptOverrides({ base: "g" }, { baseFile: "/x" });
      expect(out).toEqual({ baseFile: "/x" });
    });

    it("global base/baseFile shines through when per-agent specifies neither", () => {
      const out = mergeSystemPromptOverrides({ baseFile: "/g" }, { order: ["base"] });
      expect(out).toEqual({ baseFile: "/g", order: ["base"] });
    });

    it("per-agent order replaces global order (no merge)", () => {
      const out = mergeSystemPromptOverrides({ order: ["base", "instructions"] }, { order: ["recall_memory", "base"] });
      expect(out?.order).toEqual(["recall_memory", "base"]);
    });

    it("per-agent custom replaces global custom (no merge)", () => {
      const out = mergeSystemPromptOverrides(
        { custom: [{ name: "g_layer", content: "g" }] },
        { custom: [{ name: "a_layer", content: "a" }] },
      );
      expect(out?.custom).toEqual([{ name: "a_layer", content: "a" }]);
    });

    it("global custom shines through when per-agent has no custom", () => {
      const out = mergeSystemPromptOverrides({ custom: [{ name: "g_layer", content: "g" }] }, { base: "a" });
      expect(out?.custom).toEqual([{ name: "g_layer", content: "g" }]);
    });
  });

  it("DEFAULT_LAYER_ORDER pins the layout, including the two slot groups", () => {
    // The order is a contract: a deployment that names layers explicitly is
    // reading this list, and prompt caching depends on which of them are in
    // the tail. Slot groups sit next to the layers they resemble — standing
    // knowledge beside the catalog, per-turn state beside recall.
    expect(DEFAULT_LAYER_ORDER).toEqual([
      "base",
      "instructions",
      "context",
      "skill_catalog",
      "slots_standing",
      "core_memory",
      "chat_live_state",
      "recall_memory",
      "slots_state",
    ]);
  });

  /**
   * Adding a block should not require knowing the layout. Before this, a
   * declared custom layer was dropped unless it also appeared in `order` — so
   * the cost of adding one block was enumerating all seven built-ins, and an
   * enumeration with a name missing deleted that built-in without saying so.
   */
  describe("custom layers render without being placed", () => {
    const custom = { house_rules: "[rules]" };

    it("renders a declared custom layer that order never mentions", () => {
      const out = composeSystemPrompt("[base]", layers, undefined, custom);
      expect(out).toContain("[rules]");
    });

    it("appends it after the built-ins rather than displacing them", () => {
      const out = composeSystemPrompt("[base]", layers, undefined, custom);
      expect(out).toBe("[base][inst][ctx][cat][slots-standing][core][rules]");
    });

    it("still honours an explicit placement in order", () => {
      const override = { order: ["base", "house_rules", "instructions"], tail: [] };
      expect(composeSystemPrompt("[base]", layers, override, custom)).toBe("[base][rules][inst]");
    });

    it("does not append twice when order already placed it", () => {
      const override = { order: ["base", "house_rules"], tail: [] };
      expect(composeSystemPrompt("[base]", layers, override, custom).split("[rules]")).toHaveLength(2);
    });

    it("lets tail take a custom layer without order having to list it", () => {
      // Naming a custom layer in `tail` used to do nothing: the tail was
      // intersected with `order`, which a contributor adding one block never
      // sets. Declaring it is now enough to make it eligible.
      const override = { tail: ["house_rules"] };
      expect(resolveTailLayers(override, Object.keys(custom))).toEqual(["house_rules"]);
      expect(composeSystemPrompt("[base]", layers, override, custom)).not.toContain("[rules]");
      expect(composeTailBlock(layers, override, custom)).toBe("[rules]");
    });

    it("renders it exactly once across prompt and tail", () => {
      const prompt = composeSystemPrompt("[base]", layers, undefined, custom);
      const tail = composeTailBlock(layers, undefined, custom);
      expect(`${prompt}${tail}`.split("[rules]")).toHaveLength(2);
    });
  });

  /**
   * `order` without `tail` switching off the tail is deliberate and stays.
   * Doing it in silence is the defect: the volatile layers carry the clock, so
   * they either invalidate the cache every turn or vanish from the request.
   */
  describe("order-without-tail is announced", () => {
    it("warns, and says the volatile layers moved into the system prompt", () => {
      composeSystemPrompt("[base]", layers, { order: [...DEFAULT_LAYER_ORDER] }, {});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("without systemPrompt.tail"));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("defeats prompt caching"));
    });

    it("warns that they will not be sent at all when order omits them", () => {
      composeSystemPrompt("[base]", layers, { order: ["base", "instructions"] }, {});
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("will not be sent at all"));
    });

    it("warns once per config, not once per turn", () => {
      const override = { order: [...DEFAULT_LAYER_ORDER] };
      for (let turn = 0; turn < 5; turn++) {
        composeSystemPrompt("[base]", layers, override, {});
        composeTailBlock(layers, override, {});
      }
      const hits = warnSpy.mock.calls.filter((c) => String(c[0]).includes("without systemPrompt.tail"));
      expect(hits).toHaveLength(1);
    });

    it("stays quiet when tail is explicit", () => {
      composeSystemPrompt("[base]", layers, { order: [...DEFAULT_LAYER_ORDER], tail: ["recall_memory"] }, {});
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("without systemPrompt.tail"));
    });

    it("stays quiet when there is no override at all", () => {
      composeSystemPrompt("[base]", layers, undefined, {});
      composeTailBlock(layers, undefined, {});
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("tail layers", () => {
    it("moves the per-turn layers out of the prompt by default", () => {
      expect(resolveTailLayers(undefined)).toEqual([...DEFAULT_TAIL_LAYERS]);
      expect(composeTailBlock(layers, undefined, {})).toBe("[live][recall][slots-state]");
    });

    it("keeps every layer exactly once across prompt and tail", () => {
      const prompt = composeSystemPrompt("[base]", layers, undefined, {});
      const tail = composeTailBlock(layers, undefined, {});
      for (const block of ["[base]", "[inst]", "[ctx]", "[cat]", "[core]", "[live]", "[recall]"]) {
        expect(`${prompt}${tail}`.split(block)).toHaveLength(2);
      }
    });

    it("an explicit order keeps placement — the default tail does not overrule it", () => {
      const override = { order: ["recall_memory", "base", "instructions"] };
      expect(resolveTailLayers(override)).toEqual([]);
      expect(composeSystemPrompt("[base]", layers, override, {})).toBe("[recall][base][inst]");
      expect(composeTailBlock(layers, override, {})).toBe("");
    });

    it("an explicit order opts in by naming tail", () => {
      const override = { order: ["base", "instructions", "recall_memory"], tail: ["recall_memory"] };
      expect(composeSystemPrompt("[base]", layers, override, {})).toBe("[base][inst]");
      expect(composeTailBlock(layers, override, {})).toBe("[recall]");
    });

    it("tail: [] keeps everything in the system prompt", () => {
      const out = composeSystemPrompt("[base]", layers, { tail: [] }, {});
      expect(out).toBe("[base][inst][ctx][cat][slots-standing][core][live][recall][slots-state]");
      expect(composeTailBlock(layers, { tail: [] }, {})).toBe("");
    });

    it("a layer stripped from order stays stripped rather than reappearing in the tail", () => {
      const override = { order: ["base", "instructions"], tail: ["recall_memory"] };
      expect(composeSystemPrompt("[base]", layers, override, {})).toBe("[base][inst]");
      expect(composeTailBlock(layers, override, {})).toBe("");
    });

    it("refuses to move base", () => {
      expect(resolveTailLayers({ tail: ["base"] })).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"base" cannot move'));
    });

    it("carries custom layers into the tail", () => {
      const override = {
        order: [...DEFAULT_LAYER_ORDER, "vol"],
        tail: ["vol"],
        custom: [{ name: "vol", content: "[v]" }],
      };
      expect(composeTailBlock(layers, override, { vol: "[v]" })).toBe("[v]");
      expect(composeSystemPrompt("[base]", layers, override, { vol: "[v]" })).not.toContain("[v]");
    });

    it("per-agent tail wins over the global one", () => {
      expect(mergeSystemPromptOverrides({ tail: ["recall_memory"] }, { tail: [] })?.tail).toEqual([]);
      expect(mergeSystemPromptOverrides({ tail: ["recall_memory"] }, { base: "x" })?.tail).toEqual(["recall_memory"]);
    });

    it("returns an empty tail when the moved layers are themselves empty", () => {
      const empty: BuiltInLayers = { ...layers, chat_live_state: "", recall_memory: "", slots_state: "" };
      expect(composeTailBlock(empty, undefined, {})).toBe("");
    });
  });
});
