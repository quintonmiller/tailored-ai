/**
 * A place's card, and what a change to it says: who can change it, what
 * agents changed lately, and the line over the head of whoever just did.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ROOM, type Room } from "../avatar/scene";
import { placeless } from "./ChatStage";
import { changeLine, keepersWords, ROOM_ASK, WorldPlace, withChangeLines } from "./WorldPlace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.parse("2026-10-19T12:00:00Z");
const iso = (ago: number) => new Date(now - ago).toISOString();

describe("a change, as the agent who made it says it", () => {
  it("is a sentence", () => {
    expect(changeLine("added the bookshelf by the window")).toBe("Added the bookshelf by the window.");
    expect(changeLine("took a photo of the room!")).toBe("Took a photo of the room!");
  });

  it("shows over the head of whoever just made it, unless it said something since", () => {
    const speech = { writer: { text: "Morning.", at: iso(5_000) } };
    const changes = [
      { who: "planner", what: "added the bookshelf", at: iso(2_000) },
      { who: "planner", what: "painted the walls sage", at: iso(9_000) },
      { who: "writer", what: "added a lamp", at: iso(20_000) },
      { who: "reviewer", what: "removed the rug", at: iso(10 * 60_000) },
    ];
    const said = withChangeLines(speech, changes, now);
    // Its newest change only.
    expect(said.planner).toEqual({ text: "Added the bookshelf.", at: changes[0].at });
    // Said something after its change: that stands.
    expect(said.writer).toBe(speech.writer);
    // Long ago: nothing new to show.
    expect(said.reviewer).toBeUndefined();
    // No changes, nothing made anew.
    expect(withChangeLines(speech, undefined, now)).toBe(speech);
    // Yours have no body to show over.
    const yours = withChangeLines({}, [{ who: "sam", what: "moved the couch", at: iso(1_000), person: true }], now);
    expect(yours).toEqual({});
  });
});

describe("who can change a place", () => {
  const can = (a: string) => a !== "writer";
  it("is a home's owner, a meeting room's members, or anyone in a shared place, and you", () => {
    expect(keepersWords("home:planner", [], can)).toBe("planner, with its place tool; and you, with Edit room");
    expect(keepersWords("home:writer", [], can)).toBe("writer, once place is among its tools; and you, with Edit room");
    expect(keepersWords("room:local:trip", ["planner", "writer", "reviewer"], can)).toBe(
      "planner and reviewer, its members; and you, with Edit room",
    );
    expect(keepersWords("shared:lounge", [], can)).toMatch(/^Any agent.*and you/);
    expect(keepersWords("lobby", [], can)).toBe("You, with Edit room; agents leave the lobby as it is");
  });

  it("leaves out an agent whose own list of tools has no place", () => {
    expect([...placeless({ planner: { tools: ["read", "place"] }, writer: { tools: ["read"] }, editor: {} })]).toEqual([
      "writer",
    ]);
  });
});

describe("a place's card", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const room: Room = {
    ...DEFAULT_ROOM,
    name: "the den",
    theme: "library",
    purpose: "reading up on Lisbon",
    changes: [
      { who: "sam", what: "moved the couch", at: new Date(Date.now() - 60_000).toISOString(), person: true },
      { who: "planner", what: "added the bookshelf", at: new Date(Date.now() - 120_000).toISOString() },
      { who: "planner", what: "painted the walls sage", at: new Date(Date.now() - 3 * 3_600_000).toISOString() },
    ],
  };

  it("says what it is for, its theme, who changes it, and what was changed lately, newest first", () => {
    const onAsk = vi.fn();
    act(() =>
      root.render(
        <WorldPlace
          id="home:planner"
          room={room}
          members={["planner"]}
          canPlace={() => true}
          onAsk={onAsk}
          onClose={() => {}}
        />,
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/Home/);
    expect(text).toMatch(/the den/);
    expect(text).toMatch(/reading up on Lisbon/);
    expect(text).toMatch(/Library/);
    expect(text).toMatch(/planner, with its place tool/);
    const rows = [...container.querySelectorAll(".world-changes li")].map((li) => li.textContent);
    expect(rows).toEqual([
      "You moved the couch1 min ago",
      "planner added the bookshelf2 min ago",
      "planner painted the walls sage3 h ago",
    ]);
    const ask = [...container.querySelectorAll("button")].find((b) => /make it fit its work/.test(b.textContent ?? ""));
    act(() => ask?.click());
    expect(onAsk).toHaveBeenCalledWith("planner");
    expect(ROOM_ASK).toMatch(/reflect what you've been working on/);
  });

  it("says so when nothing has been changed, and offers no ask where the owner can't change it", () => {
    act(() =>
      root.render(
        <WorldPlace
          id="home:writer"
          room={{ ...DEFAULT_ROOM, name: "writer's room" }}
          members={["writer"]}
          canPlace={() => false}
          onAsk={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    expect(container.textContent).toMatch(/Nothing yet/);
    expect(container.textContent).toMatch(/Nobody has said yet/);
    // Where to give it the tool instead.
    expect(container.querySelector('a[href="#/agents/writer"]')?.textContent).toBe(
      "Give writer the place tool on its page",
    );
    act(() =>
      root.render(
        <WorldPlace
          id="room:local:trip"
          room={{ ...DEFAULT_ROOM, name: "trip" }}
          members={["planner"]}
          canPlace={() => true}
          onClose={() => {}}
        />,
      ),
    );
    // A meeting room goes by its room's name, as on the map.
    expect(container.querySelector(".world-panel-title")?.textContent).toBe("#trip");
    expect([...container.querySelectorAll("button")].some((b) => /make it fit/.test(b.textContent ?? ""))).toBe(false);
    expect(container.querySelector('a[href^="#/agents/"]')).toBeNull();
  });

  it("says what the lobby is for itself, since nobody gives it a purpose or a theme", () => {
    act(() =>
      root.render(
        <WorldPlace
          id="lobby"
          room={{ ...DEFAULT_ROOM, name: "the lobby" }}
          members={[]}
          canPlace={() => true}
          onClose={() => {}}
        />,
      ),
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/Where everyone starts: the kiosks, the task board/);
    expect(text).not.toMatch(/Nobody has said yet|Theme/);
    expect(text).toMatch(/You, with Edit room; agents leave the lobby as it is/);
  });
});
