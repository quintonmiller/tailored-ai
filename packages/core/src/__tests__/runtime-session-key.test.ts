/**
 * Coverage for the centralized session-key helpers introduced for #39.
 * Channels (Discord, Slack, future Telegram/iMessage) used to hand-roll
 * `${channelId}:${userId}` strings; this suite locks down the round-trip
 * contract so a drift on one channel doesn't quietly break the others.
 */

import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime.js";

/**
 * Lightweight runtime-shaped object. The session-key helpers are pure (no
 * config, no db, no provider reads) so we only need the prototype method —
 * full construction is heavyweight and not worth it for two-LOC functions.
 */
const runtime = Object.create(AgentRuntime.prototype) as AgentRuntime;

describe("makeSessionKey", () => {
  it("builds <channelId>:<userId> with no project", () => {
    expect(runtime.makeSessionKey({ channelId: "discord", userId: "U-1" })).toBe("discord:U-1");
  });

  it("builds <channelId>:<projectId>:<userId> with a project ref", () => {
    expect(
      runtime.makeSessionKey({
        channelId: "slack",
        userId: "U-1",
        project: { id: "proj_alpha", name: "Alpha", path: "/srv/alpha" },
      }),
    ).toBe("slack:proj_alpha:U-1");
  });

  it("treats project: null as no project", () => {
    expect(runtime.makeSessionKey({ channelId: "discord", userId: "U-1", project: null })).toBe("discord:U-1");
  });

  it("rejects empty channelId / userId", () => {
    expect(() => runtime.makeSessionKey({ channelId: "", userId: "U-1" })).toThrow(/channelId is required/);
    expect(() => runtime.makeSessionKey({ channelId: "discord", userId: "" })).toThrow(/userId is required/);
  });

  it("rejects inputs containing the ':' delimiter", () => {
    expect(() => runtime.makeSessionKey({ channelId: "dis:cord", userId: "U-1" })).toThrow(/channelId cannot contain/);
    expect(() => runtime.makeSessionKey({ channelId: "discord", userId: "U:1" })).toThrow(/userId cannot contain/);
    expect(() =>
      runtime.makeSessionKey({
        channelId: "discord",
        userId: "U-1",
        project: { id: "proj:bad", name: "x", path: "/x" },
      }),
    ).toThrow(/project.id cannot contain/);
  });
});

describe("parseSessionKey", () => {
  it("parses a 2-part key as { channelId, userId }", () => {
    expect(runtime.parseSessionKey("discord:U-1")).toEqual({ channelId: "discord", userId: "U-1" });
  });

  it("parses a 3-part key as { channelId, projectId, userId }", () => {
    expect(runtime.parseSessionKey("slack:proj_alpha:U-1")).toEqual({
      channelId: "slack",
      projectId: "proj_alpha",
      userId: "U-1",
    });
  });

  it("returns undefined for unrecognized shapes", () => {
    expect(runtime.parseSessionKey("")).toBeUndefined();
    expect(runtime.parseSessionKey("single")).toBeUndefined();
    expect(runtime.parseSessionKey("a:b:c:d")).toBeUndefined();
    expect(runtime.parseSessionKey(":U-1")).toBeUndefined();
    expect(runtime.parseSessionKey("discord:")).toBeUndefined();
    expect(runtime.parseSessionKey("a::c")).toBeUndefined();
  });
});

describe("parse(make(x)) round-trip", () => {
  it("preserves channelId/userId with no project", () => {
    const key = runtime.makeSessionKey({ channelId: "discord", userId: "U-1" });
    expect(runtime.parseSessionKey(key)).toEqual({ channelId: "discord", userId: "U-1" });
  });

  it("preserves channelId/projectId/userId with a project", () => {
    const key = runtime.makeSessionKey({
      channelId: "slack",
      userId: "U-42",
      project: { id: "proj_x", name: "X", path: "/x" },
    });
    expect(runtime.parseSessionKey(key)).toEqual({
      channelId: "slack",
      projectId: "proj_x",
      userId: "U-42",
    });
  });
});

describe("getPrimaryOwner", () => {
  // getPrimaryOwner only reads this.getConfig(); stub it on a prototype-shaped
  // runtime like the session-key suite above.
  const withConfig = (config: unknown): AgentRuntime => {
    const r = Object.create(AgentRuntime.prototype) as AgentRuntime;
    (r as unknown as { getConfig: () => unknown }).getConfig = () => config;
    return r;
  };

  it("resolves the Discord owner with no defaultChannel (back-compat)", () => {
    // Preserves the historical discord:<owner> primary-session key.
    const r = withConfig({ channels: { discord: { owner: "U-owner" } } });
    expect(r.getPrimaryOwner()).toEqual({
      channelId: "discord",
      userId: "U-owner",
      displayName: "U-owner",
    });
  });

  it("honors an explicit defaultChannel", () => {
    const r = withConfig({
      defaultChannel: "slack",
      channels: { discord: { owner: "D-1" }, slack: { owner: "S-1" } },
    });
    expect(r.getPrimaryOwner()).toEqual({ channelId: "slack", userId: "S-1", displayName: "S-1" });
  });

  it("picks the first channel that declares an owner when no defaultChannel", () => {
    const r = withConfig({
      channels: { log: { enabled: true }, slack: { owner: "S-2" } },
    });
    expect(r.getPrimaryOwner()).toEqual({ channelId: "slack", userId: "S-2", displayName: "S-2" });
  });

  it("uses ownerName for displayName when present", () => {
    const r = withConfig({ channels: { discord: { owner: "U-9", ownerName: "Quinton" } } });
    expect(r.getPrimaryOwner()).toEqual({ channelId: "discord", userId: "U-9", displayName: "Quinton" });
  });

  it("falls back to synthetic owner when a channel exists but declares no owner", () => {
    const r = withConfig({ channels: { discord: { enabled: true } } });
    expect(r.getPrimaryOwner()).toEqual({
      channelId: "discord",
      userId: "owner",
      displayName: "the user",
    });
  });

  it("keeps the named defaultChannel even when it declares no owner", () => {
    const r = withConfig({ defaultChannel: "slack", channels: { slack: { enabled: true } } });
    expect(r.getPrimaryOwner()).toEqual({ channelId: "slack", userId: "owner", displayName: "the user" });
  });

  it("uses a synthetic 'primary' channel when nothing is configured", () => {
    const r = withConfig({ channels: {} });
    expect(r.getPrimaryOwner()).toEqual({
      channelId: "primary",
      userId: "owner",
      displayName: "the user",
    });
  });

  it("ignores a non-string owner field", () => {
    const r = withConfig({ channels: { discord: { owner: 12345 } } });
    expect(r.getPrimaryOwner()).toEqual({
      channelId: "discord",
      userId: "owner",
      displayName: "the user",
    });
  });
});

describe("getOwnerId", () => {
  const withConfig = (config: unknown): AgentRuntime => {
    const r = Object.create(AgentRuntime.prototype) as AgentRuntime;
    (r as unknown as { getConfig: () => unknown }).getConfig = () => config;
    return r;
  };

  it("returns the real owner of the primary channel", () => {
    const r = withConfig({ channels: { discord: { owner: "U-1" } } });
    expect(r.getOwnerId()).toBe("U-1");
  });

  it("returns the owner of an explicit channel id", () => {
    const r = withConfig({ channels: { discord: { owner: "D-1" }, slack: { owner: "S-1" } } });
    expect(r.getOwnerId("slack")).toBe("S-1");
  });

  it("returns undefined (not a synthetic 'owner') when none is configured", () => {
    // The key difference from getPrimaryOwner: delivery consumers must be able
    // to skip rather than DM a fake recipient.
    const r = withConfig({ channels: { discord: { enabled: true } } });
    expect(r.getOwnerId()).toBeUndefined();
    expect(r.getPrimaryOwner().userId).toBe("owner");
  });

  it("follows defaultChannel", () => {
    const r = withConfig({ defaultChannel: "slack", channels: { discord: { owner: "D" }, slack: { owner: "S" } } });
    expect(r.getOwnerId()).toBe("S");
  });

  it("returns undefined for a non-string owner", () => {
    const r = withConfig({ channels: { discord: { owner: 999 } } });
    expect(r.getOwnerId()).toBeUndefined();
  });
});
