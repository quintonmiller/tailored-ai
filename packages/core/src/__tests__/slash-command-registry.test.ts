/**
 * Slash-command seam — plugins register chat commands without core importing a
 * chat SDK.
 *
 * The interesting constraint is that these cannot be namespaced. HTTP routes
 * hide plugin paths under `/api/ext/<prefix>/` so a plugin can never shadow a
 * core route; chat platforms give you a flat namespace with no separator, so
 * the equivalent protection has to be refusal at registration time.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RESERVED_COMMAND_NAMES,
  SlashCommandConflictError,
  SlashCommandRegistry,
  slashCommandRegistry,
} from "../commands/registry.js";
import { createPluginContext } from "../plugin-context.js";

const descriptor = (over: Partial<Parameters<SlashCommandRegistry["register"]>[0]> = {}) => ({
  name: "instance",
  description: "Switch instance",
  handler: () => ({ content: "ok" }),
  ...over,
});

afterEach(() => slashCommandRegistry.clear());

describe("register", () => {
  it("registers and returns the descriptor", () => {
    const reg = new SlashCommandRegistry();
    reg.register(descriptor());

    expect(reg.get("instance")?.description).toBe("Switch instance");
    expect(reg.list()).toHaveLength(1);
  });

  it("returns a disposer that removes it", () => {
    const reg = new SlashCommandRegistry();
    const off = reg.register(descriptor());

    off();

    expect(reg.get("instance")).toBeUndefined();
  });

  /**
   * A plugin re-registering across a config reload replaces the entry. The
   * stale disposer must then be inert, or disabling the old instance would
   * delete the live command.
   */
  it("a stale disposer does not remove a replacement", () => {
    const reg = new SlashCommandRegistry();
    const off = reg.register(descriptor());
    off();
    reg.register(descriptor({ description: "Second registration" }));

    off();

    expect(reg.get("instance")?.description).toBe("Second registration");
  });
});

describe("collisions", () => {
  /** The whole reason this registry refuses instead of namespacing. */
  it.each(RESERVED_COMMAND_NAMES)("refuses the built-in name %s", (name) => {
    const reg = new SlashCommandRegistry();

    expect(() => reg.register(descriptor({ name }))).toThrow(SlashCommandConflictError);
    expect(reg.get(name)).toBeUndefined();
  });

  it("refuses a name another plugin already took", () => {
    const reg = new SlashCommandRegistry();
    reg.register(descriptor());

    expect(() => reg.register(descriptor({ description: "Impostor" }))).toThrow(/already registered/);
    expect(reg.get("instance")?.description).toBe("Switch instance");
  });

  it("names the offending command in the error, since a plugin author sees only this", () => {
    const reg = new SlashCommandRegistry();

    expect(() => reg.register(descriptor({ name: "room" }))).toThrow(/"room"/);
  });
});

describe("validation", () => {
  it.each([
    ["", "empty"],
    ["Instance", "uppercase"],
    ["my instance", "a space"],
    ["a".repeat(33), "over 32 characters"],
    ["inst/ance", "a slash"],
  ])("refuses %j — %s", (name) => {
    const reg = new SlashCommandRegistry();
    expect(() => reg.register(descriptor({ name }))).toThrow(SlashCommandConflictError);
  });

  it("refuses an option whose name Discord would reject", () => {
    const reg = new SlashCommandRegistry();

    expect(() =>
      reg.register(descriptor({ options: [{ name: "Target Name", description: "x", type: "string" }] })),
    ).toThrow(/option/);
  });

  it("refuses a descriptor with no callable handler", () => {
    const reg = new SlashCommandRegistry();

    expect(() => reg.register(descriptor({ handler: undefined as never }))).toThrow(/handler/);
  });
});

describe("restrictions", () => {
  /**
   * The channel enforces this before the handler runs, so a plugin shipping a
   * privileged command declares it once here rather than hand-rolling a check
   * in every handler — which is what the absence of this field forced.
   */
  it("reports a declared owner restriction", () => {
    const reg = new SlashCommandRegistry();
    reg.register(descriptor({ name: "deploy", restrict: "owner" }));

    expect(reg.restrictions().get("deploy")).toBe("owner");
  });

  it("defaults an undeclared command to anyone", () => {
    const reg = new SlashCommandRegistry();
    reg.register(descriptor({ name: "status" }));

    expect(reg.restrictions().get("status")).toBe("anyone");
  });

  it("drops a command from the map once its disposer runs", () => {
    const reg = new SlashCommandRegistry();
    const off = reg.register(descriptor({ name: "deploy", restrict: "owner" }));

    off();

    expect(reg.restrictions().has("deploy")).toBe(false);
  });
});

describe("plugin context", () => {
  it("exposes register through ctx.commands", async () => {
    const ctx = createPluginContext();
    const handler = vi.fn(() => ({ content: "hi" }));

    ctx.commands.register({ name: "demo", description: "Demo", handler });

    const found = slashCommandRegistry.get("demo");
    expect(found).toBeDefined();
    expect(await found?.handler({ command: "demo", options: {}, user: { id: "1", username: "q" } })).toEqual({
      content: "hi",
    });
  });

  /** A plugin that throws on register must not be silently swallowed. */
  it("propagates a conflict to the plugin author", () => {
    const ctx = createPluginContext();

    expect(() => ctx.commands.register({ name: "memory", description: "x", handler: () => ({ content: "" }) })).toThrow(
      SlashCommandConflictError,
    );
  });
});
