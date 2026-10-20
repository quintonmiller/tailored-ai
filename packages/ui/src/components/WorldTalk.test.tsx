/**
 * Your conversation in the world: the last few turns as a dialogue beside the
 * agent, its reply coming in as it arrives, and a call when it is somewhere
 * else.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastLines, TALK_LINES, WorldTalk } from "./WorldTalk";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("the last few things said", () => {
  it("are yours and its words, oldest first, without the work between or a picture sent alone", () => {
    const messages = [
      { role: "user", content: "Where should we stay?" },
      { role: "tool", content: "searched hotels" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Alfama, near the river." },
      { role: "system", content: "a note to the model" },
      { role: "user", content: { parts: [{ type: "media", media: { id: "m1" } }] } },
      { role: "user", content: { parts: [{ type: "text", text: "Book it." }] } },
    ];
    expect(lastLines(messages)).toEqual([
      { who: "you", text: "Where should we stay?" },
      { who: "agent", text: "Alfama, near the river." },
      { who: "you", text: "Book it." },
    ]);
  });

  it("are only the last few", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `line ${i}` }));
    const shown = lastLines(many);
    expect(shown).toHaveLength(TALK_LINES);
    expect(shown.at(-1)?.text).toBe("line 19");
  });
});

describe("your conversation beside an agent", () => {
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

  it("shows its words and yours apart, the reply coming in, and what it is doing about your turn", () => {
    let full = 0;
    act(() =>
      root.render(
        <WorldTalk
          name="planner"
          lines={[
            { who: "you", text: "Where should we stay?" },
            { who: "agent", text: "Alfama." },
          ]}
          heard="And the flights?"
          replying="Looking at"
          status="Calling search…"
          onFull={() => full++}
        >
          <input aria-label="Message planner" />
        </WorldTalk>,
      ),
    );
    const lines = [...container.querySelectorAll(".world-talk-line")].map((l) => [l.className, l.textContent]);
    expect(lines).toEqual([
      ["world-talk-line world-talk-you", "Where should we stay?"],
      ["world-talk-line world-talk-agent", "Alfama."],
      ["world-talk-line world-talk-you", "And the flights?"],
      ["world-talk-line world-talk-agent world-talk-live", "Looking at"],
    ]);
    expect(container.querySelector(".world-talk-status")?.textContent).toBe("Calling search…");
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Talking with planner");
    // Not a dialog: keys outside it still walk you, and Escape still stops a reply.
    expect(container.querySelector("[role='dialog']")).toBeNull();
    expect(container.querySelector(".world-talk-compose input")).not.toBeNull();
    act(() => (container.querySelector(".world-talk-full") as HTMLButtonElement).click());
    expect(full).toBe(1);
  });

  it("is a call to an agent somewhere else, and says how to start with nothing said yet", () => {
    act(() =>
      root.render(
        <WorldTalk name="writer" lines={[]} phone onFull={() => {}}>
          <input aria-label="Message writer" />
        </WorldTalk>,
      ),
    );
    expect(container.querySelector(".world-talk-phone .world-talk-handset")).not.toBeNull();
    expect(container.querySelector(".world-talk-head")?.textContent).toMatch(/On the phone with writer/);
    expect(container.querySelector(".world-talk-hint")?.textContent).toMatch(/hold Space to talk/);
    // A reply on its way with no words yet: dots, said as replying.
    act(() =>
      root.render(
        <WorldTalk name="writer" lines={[]} phone replying="" onFull={() => {}}>
          <input aria-label="Message writer" />
        </WorldTalk>,
      ),
    );
    expect(container.querySelector(".world-talk-hint")).toBeNull();
    expect(container.querySelector(".world-talk-live [aria-label='Replying']")).not.toBeNull();
  });
});
