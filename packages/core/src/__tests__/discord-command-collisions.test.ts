/**
 * Discord: one duplicate command name must not take out the guild (#330).
 *
 * Discord requires command names to be unique within a scope and rejects the
 * whole bulk overwrite when two match. The overwrite is all-or-nothing, so a
 * rejected payload changes nothing: the guild keeps whatever last registered
 * successfully and *every* command is frozen — `/pause` included, which is the
 * one you reach for when something is wrong. On a first run the guild gets no
 * commands at all, and the only symptom is one line of console.error.
 *
 * One character of config could do it: name normalization erases the difference
 * between `Deploy`, `deploy` and `deploy!`.
 */
import { SlashCommandBuilder } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordChannel, dedupeCommandNames } from "../channels/discord.js";
import { PAUSE_COMMAND_NAME } from "../channels/discord-pause-commands.js";
import { RESERVED_COMMAND_NAMES, slashCommandRegistry } from "../commands/registry.js";
import type { AgentRuntime } from "../runtime.js";

const cmd = (name: string, description = `desc for ${name}`) =>
  new SlashCommandBuilder().setName(name).setDescription(description) as SlashCommandBuilder;

function buildWith(commands: Record<string, { description: string; prompt?: string }>): SlashCommandBuilder[] {
  const runtime = {
    getConfig: () => ({
      commands,
      agents: { coder: { description: "writes code" } },
      channels: { discord: {} },
    }),
  } as unknown as AgentRuntime;
  const channel = new DiscordChannel({ runtime });
  // Private, and reaching for it directly is the point: the payload it returns
  // is what Discord accepts or rejects wholesale.
  return (channel as unknown as { buildSlashCommands(): SlashCommandBuilder[] }).buildSlashCommands();
}

describe("dedupeCommandNames", () => {
  it("keeps the first of a colliding pair and drops the later one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kept = dedupeCommandNames([cmd("pause", "built-in"), cmd("deploy"), cmd("pause", "from config")]);

    expect(kept.map((c) => c.name)).toEqual(["pause", "deploy"]);
    expect(kept[0].description).toBe("built-in");
    warn.mockRestore();
  });

  it("names the collision so the next one is findable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    dedupeCommandNames([cmd("deploy"), cmd("deploy")]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"deploy"');
    warn.mockRestore();
  });

  it("leaves a payload with no collisions exactly as it was", () => {
    const input = [cmd("a"), cmd("b"), cmd("c")];
    expect(dedupeCommandNames(input)).toEqual(input);
  });
});

describe("buildSlashCommands collisions", () => {
  it("does not let a config command displace the emergency stop", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const built = buildWith({ pause: { description: "Pause the deploy pipeline" } });

    const pause = built.filter((c) => c.name === PAUSE_COMMAND_NAME);
    expect(pause).toHaveLength(1);
    // The built-in survived, not the config entry that wanted its name.
    expect(pause[0].description).toContain("Stop agents starting new runs");
    warn.mockRestore();
  });

  it("emits each name at most once, whatever config asks for", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // All three normalize to `deploy`, which is the config-vs-config half of
    // the bug and needs no built-in to trigger.
    const built = buildWith({
      Deploy: { description: "one" },
      deploy: { description: "two" },
      "deploy!": { description: "three" },
    });

    const names = built.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n === "deploy")).toHaveLength(1);
    warn.mockRestore();
  });

  it("keeps a non-colliding config command", () => {
    const built = buildWith({ standup: { description: "Run standup" } });

    expect(built.map((c) => c.name)).toContain("standup");
  });

  it("puts every built-in ahead of plugin and config commands", () => {
    // Push order is precedence order, because dedupe keeps the first. The
    // registry already refuses `RESERVED_COMMAND_NAMES`, so a plugin cannot
    // take `/pause` today — this is what keeps that true if the hand-kept
    // reserved list ever drifts from the set actually built here. Plugin
    // commands used to be pushed above /room, /memory, /pause, /resume and
    // /clone-agent.
    const drop = slashCommandRegistry.register({
      name: "weather",
      description: "Forecast",
      handler: async () => ({ body: "sunny" }),
    });
    try {
      const built = buildWith({ standup: { description: "Run standup" } });
      const names = built.map((c) => c.name);
      const plugin = names.indexOf("weather");
      const config = names.indexOf("standup");

      expect(plugin).toBeGreaterThan(-1);
      expect(config).toBeGreaterThan(plugin);
      for (const builtIn of RESERVED_COMMAND_NAMES) {
        expect(names.indexOf(builtIn)).toBeLessThan(plugin);
      }
    } finally {
      drop();
    }
  });

  it("registers the built-in stop commands even with a hostile config", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const built = buildWith({
      pause: { description: "x" },
      resume: { description: "y" },
      room: { description: "z" },
      memory: { description: "w" },
    });

    for (const name of ["pause", "resume", "room", "memory"]) {
      expect(built.filter((c) => c.name === name)).toHaveLength(1);
    }
    warn.mockRestore();
  });
});
