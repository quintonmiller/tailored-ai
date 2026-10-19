/**
 * The top of the chat panel over the scene: who you are talking to, in their
 * body's colour, what they are doing, and a way to talk to someone else; and
 * in a meeting room, the room's own conversation and its members to pick.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivity } from "../avatar/doing";
import { ChatWith, RoomLines, RoomWith, useRoomTalk } from "./ChatWith";
import { agentColor } from "./WorldMap";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let transcriptStatus = 200;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  transcriptStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === `/api/ext/builtin:places/transcript/${encodeURIComponent("room:local:trip")}`) {
        if (transcriptStatus !== 200)
          return new Response(JSON.stringify({ error: "The discord rooms aren't connected right now." }), {
            status: transcriptStatus,
          });
        return new Response(
          JSON.stringify({
            id: "room:local:trip",
            name: "trip",
            purpose: "Plan the trip",
            members: ["planner", "writer"],
            lines: [
              {
                id: "1",
                who: "planner",
                agent: "planner",
                to: [],
                text: "Flights are booked.",
                at: new Date().toISOString(),
              },
              {
                id: "2",
                who: "Sam",
                to: ["planner"],
                text: "Window seat, please.",
                at: new Date().toISOString(),
                files: 1,
              },
            ],
          }),
        );
      }
      return new Response("{}");
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(node: React.ReactNode) {
  await act(async () => root.render(node));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const working: AgentActivity = { agent: "planner", doing: "working", what: "searching the web", detail: "hotels" };

describe("who you are talking to", () => {
  it("names them, with a dot in their body's colour and what they are doing", async () => {
    await show(
      <ChatWith agent="planner" agents={["planner", "writer"]} activity={working} next={null} onSwitch={() => {}} />,
    );
    expect(container.querySelector(".chat-with-who strong")?.textContent).toBe("planner");
    const dot = container.querySelector(".chat-with-dot") as HTMLElement;
    // jsdom normalises the colour; the same normalisation of the map's colour must match.
    const probe = document.createElement("span");
    probe.style.background = agentColor("planner");
    expect(dot.style.background).toBe(probe.style.background);
    expect(container.querySelector(".chat-with-doing")?.textContent).toMatch(/searching the web.*hotels/);
  });

  it("calls the default agent by name, with no dot, and nothing to say while it is idle", async () => {
    await show(<ChatWith agent="" agents={["planner"]} activity={undefined} next={null} onSwitch={() => {}} />);
    expect(container.querySelector(".chat-with-who strong")?.textContent).toBe("Default agent");
    expect(container.querySelector(".chat-with-dot")).toBeNull();
    expect(container.querySelector(".chat-with-doing")).toBeNull();
  });

  it("switches to whoever you pick, and says when a switch is waiting for a reply", async () => {
    const picked: string[] = [];
    await show(
      <ChatWith
        agent=""
        agents={["planner", "writer"]}
        activity={undefined}
        next="writer"
        onSwitch={(a) => picked.push(a)}
      />,
    );
    expect(container.querySelector(".chat-with-doing")?.textContent).toBe("Then writer, once this reply is done");
    const select = container.querySelector(".chat-with-switch select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Default agent", "planner", "writer"]);
    await act(async () => {
      select.value = "planner";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(picked).toEqual(["planner"]);
  });
});

describe("a meeting room", () => {
  function Room({ talkedTo }: { talkedTo: string[] }) {
    const talk = useRoomTalk("room:local:trip");
    const [reading, setReading] = useState(true);
    return (
      <>
        <RoomWith
          talk={talk}
          fallbackName="trip"
          reading={reading}
          agent=""
          activities={{ planner: working }}
          onRead={() => setReading(true)}
          onTalk={(a) => {
            talkedTo.push(a);
            setReading(false);
          }}
        />
        {reading && <RoomLines talk={talk} />}
      </>
    );
  }

  it("reads out the room's conversation, who said what to whom, with its members to talk to", async () => {
    const talkedTo: string[] = [];
    await show(<Room talkedTo={talkedTo} />);
    expect(container.querySelector(".chat-with-who")?.textContent).toBe("#tripPlan the trip");
    const tabs = [...container.querySelectorAll(".chat-with-tabs button")] as HTMLButtonElement[];
    expect(tabs.map((t) => t.textContent)).toEqual(["Room", "planner", "writer"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    // What a member is doing shows on hover.
    expect(tabs[1].title).toMatch(/searching the web/);
    const lines = [...container.querySelectorAll(".room-line")].map((l) => l.textContent?.replace(/\s+/g, " ").trim());
    expect(lines[0]).toMatch(/^planner.*Flights are booked\.$/);
    expect(lines[1]).toMatch(/^Samto planner.*Window seat, please\. ?A file came with it\.$/);
    await act(async () => tabs[2].click());
    expect(talkedTo).toEqual(["writer"]);
    expect(container.querySelector(".room-lines")).toBeNull();
  });

  it("says why when the room can't be read", async () => {
    transcriptStatus = 503;
    await show(<Room talkedTo={[]} />);
    expect(container.querySelector(".room-lines-note")?.textContent).toBe(
      "The discord rooms aren't connected right now.",
    );
    // The name still shows, from the scene.
    expect(container.querySelector(".chat-with-who strong")?.textContent).toBe("#trip");
  });
});
