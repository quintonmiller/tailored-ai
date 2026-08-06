/**
 * getDiscordConfig parses the Discord channel's slice of the generic
 * `config.channels` map. The Discord channel owns its own schema — core's
 * config carries no per-channel types — so this coerces an opaque bag.
 */
import { describe, expect, it } from "vitest";
import { getDiscordConfig } from "../channels/discord-config.js";
import type { AgentConfig } from "../config.js";

function cfg(discord: unknown): AgentConfig {
  return { channels: { discord } } as AgentConfig;
}

describe("getDiscordConfig", () => {
  it("returns undefined when discord isn't configured", () => {
    expect(getDiscordConfig({ channels: {} } as AgentConfig)).toBeUndefined();
    expect(getDiscordConfig(cfg(undefined))).toBeUndefined();
    expect(getDiscordConfig(cfg("nonsense"))).toBeUndefined();
  });

  it("parses archiveCategory, and leaves it undefined when unset", () => {
    expect(getDiscordConfig(cfg({ archiveCategory: "Archived" }))?.archiveCategory).toBe("Archived");
    // Unset is meaningful: it means "leave archived channels where they are".
    expect(getDiscordConfig(cfg({ token: "t" }))?.archiveCategory).toBeUndefined();
    expect(getDiscordConfig(cfg({ archiveCategory: 42 }))?.archiveCategory).toBeUndefined();
  });

  it("parses the typed fields from the opaque bag", () => {
    const d = getDiscordConfig(
      cfg({
        enabled: true,
        token: "t",
        owner: "123",
        allowedGuilds: ["g1", "g2"],
        respondToDMs: false,
        respondToMentions: true,
      }),
    );
    expect(d).toEqual({
      enabled: true,
      token: "t",
      owner: "123",
      allowedGuilds: ["g1", "g2"],
      respondToDMs: false,
      respondToMentions: true,
      projectMappings: undefined,
    });
  });

  it("drops wrong-typed fields rather than throwing", () => {
    const d = getDiscordConfig(cfg({ token: 42, owner: true, allowedGuilds: "g1", respondToDMs: "yes" }));
    expect(d?.token).toBeUndefined();
    expect(d?.owner).toBeUndefined();
    expect(d?.allowedGuilds).toBeUndefined();
    expect(d?.respondToDMs).toBeUndefined();
  });

  it("keeps only well-formed project mappings (channel or dm + project)", () => {
    const d = getDiscordConfig(
      cfg({
        projectMappings: [
          { channel: "c1", project: "p1" },
          { dm: true, project: "p2" },
          { dm: true }, // no project — dropped
          { channel: "c3" }, // no project — dropped
          "garbage",
        ],
      }),
    );
    expect(d?.projectMappings).toEqual([
      { channel: "c1", project: "p1" },
      { dm: true, project: "p2" },
    ]);
  });
});
