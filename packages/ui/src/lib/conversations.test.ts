/**
 * A web conversation's key says who it is with, so going to an agent picks
 * up your latest conversation with it.
 */
import { describe, expect, it } from "vitest";
import type { SessionRow } from "../api";
import { agentOfKey, askedIn, latestWith, nameOf, newChatKey } from "./conversations";

const row = (key: string | null, updated: string, pinned = 0): SessionRow => ({
  id: `s-${key}`,
  key,
  model: "m",
  provider: "p",
  project_id: null,
  title: null,
  pinned,
  created_at: updated,
  updated_at: updated,
});

describe("newChatKey and agentOfKey", () => {
  it("names the agent in a new conversation's key, and reads it back", () => {
    expect(newChatKey("planner", 1700)).toBe("web:planner:1700");
    expect(agentOfKey("web:planner:1700")).toBe("planner");
  });

  it('calls the default agent by name in the key, and "" in the chat', () => {
    expect(newChatKey("", 1700)).toBe("web:default:1700");
    expect(agentOfKey("web:default:1700")).toBe("");
  });

  it("can't say who a conversation is with from an older key, or one from another channel", () => {
    expect(agentOfKey("web:1700")).toBeUndefined();
    expect(agentOfKey("discord:123:planner")).toBeUndefined();
    expect(agentOfKey(null)).toBeUndefined();
  });
});

describe("latestWith", () => {
  const sessions = [
    // Pinned ones come first in the list, but the latest is what counts.
    row("web:planner:1", "2026-10-01 09:00:00", 1),
    row("web:planner:2", "2026-10-03 09:00:00"),
    row("web:writer:3", "2026-10-04 09:00:00"),
    row("discord:planner:dm", "2026-10-05 09:00:00"),
    row("web:5", "2026-10-02 09:00:00"),
    row("web:default:6", "2026-09-30 09:00:00"),
  ];

  it("finds your latest web conversation with an agent, and none from another channel", () => {
    expect(latestWith(sessions, "planner")?.key).toBe("web:planner:2");
    expect(latestWith(sessions, "writer")?.key).toBe("web:writer:3");
  });

  it("leaves older keys that don't name an agent alone: they could be with anyone", () => {
    // web:5 is the newer, but nothing says it was with the default agent.
    expect(latestWith(sessions, "")?.key).toBe("web:default:6");
    expect(latestWith([row("web:5", "2026-10-02 09:00:00")], "")).toBeUndefined();
  });

  it("finds nothing with an agent you haven't talked to", () => {
    expect(latestWith(sessions, "trip-planner")).toBeUndefined();
  });
});

describe("askedIn", () => {
  const sessions = [
    row("web:assistant:1700", "2026-10-19 09:00:00"),
    row("web:default:1800", "2026-10-19 09:00:00"),
    row("web:1900", "2026-10-19 09:00:00"),
    row("discord:123:assistant", "2026-10-19 09:00:00"),
  ];

  it("is the conversation the question was asked in, when it is yours with that agent", () => {
    expect(askedIn(sessions, "s-web:assistant:1700", "assistant")?.key).toBe("web:assistant:1700");
    expect(askedIn(sessions, "s-web:default:1800", "")?.key).toBe("web:default:1800");
  });

  it("is none for another agent's, an older key, another channel's, one not listed, or none asked", () => {
    expect(askedIn(sessions, "s-web:assistant:1700", "planner")).toBeUndefined();
    expect(askedIn(sessions, "s-web:1900", "assistant")).toBeUndefined();
    expect(askedIn(sessions, "s-discord:123:assistant", "assistant")).toBeUndefined();
    expect(askedIn(sessions, "s-gone", "assistant")).toBeUndefined();
    expect(askedIn(sessions, undefined, "assistant")).toBeUndefined();
  });
});

describe("nameOf", () => {
  it("calls the default agent the same everywhere, and any other agent by its name", () => {
    expect(nameOf("")).toBe("Default agent");
    expect(nameOf("default")).toBe("Default agent");
    expect(nameOf("planner")).toBe("planner");
  });
});
