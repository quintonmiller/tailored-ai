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
