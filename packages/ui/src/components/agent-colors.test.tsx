/**
 * One colour for each agent, everywhere it is listed: the dot by its name on
 * the map, in the needs list and on its card is the colour it chose for its
 * body with the `body` tool when it chose one, read from one shared source
 * (`useAgentColor`), and changes everywhere at once when it chooses again.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateChangeInfo } from "../api";
import type { Need } from "../lib/needs";
import { WorldAgent } from "./WorldAgent";
import { agentColor, type MapPlace, WorldMap } from "./WorldMap";
import { NeedsList } from "./WorldNeeds";

// Changes to the world, as the page hears of them.
const heard = vi.hoisted(() => ({ listeners: new Set<(change: unknown) => void>() }));
vi.mock("../lib/state-events", () => ({
  subscribeStateChanges: (listener: (change: unknown) => void) => {
    heard.listeners.add(listener);
    return () => heard.listeners.delete(listener);
  },
}));
const hear = (change: Partial<StateChangeInfo>) =>
  act(() => {
    for (const listener of heard.listeners) listener(change);
  });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let bodies: { id: string; data: Record<string, unknown> }[];

beforeEach(() => {
  bodies = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/state/body?limit=500"
        ? new Response(JSON.stringify({ records: bodies }))
        : new Response(JSON.stringify({ agents: [] })),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** A colour as jsdom writes it back, to compare with what a dot was given. */
const css = (color: string) => {
  const probe = document.createElement("span");
  probe.style.background = color;
  return probe.style.background;
};

// The map's home for planner says nothing of its colour: the dot is the body's all the same.
const places: MapPlace[] = [
  { id: "home:planner", name: "planner's room", kind: "home", owner: "planner", role: "travel agent", agents: [] },
];
const need: Need = {
  key: "approval:r1",
  agent: "planner",
  kind: "approval",
  what: "waiting for your OK",
  since: new Date().toISOString(),
};

async function everywhere() {
  await act(async () =>
    root.render(
      <>
        <WorldMap places={places} problem={null} here={undefined} activities={{}} onGo={() => {}} onClose={() => {}} />
        <NeedsList needs={[need]} whereOf={() => undefined} onOpen={() => {}} onClose={() => {}} />
        <WorldAgent
          agent="planner"
          activity={undefined}
          said={undefined}
          roomName={() => undefined}
          where={undefined}
          openTasks={0}
          online={false}
          talking={false}
          tasksWake={undefined}
          onChat={() => {}}
          onTasks={() => {}}
          onClose={() => {}}
        />
      </>,
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

const dots = () => ({
  map: (container.querySelector(".world-map-who .world-map-hue") as HTMLElement).style.background,
  needs: (container.querySelector(".world-needs-who") as HTMLElement).style.getPropertyValue("--who"),
  card: (container.querySelector(".world-agent-dot") as HTMLElement).style.background,
});

describe("an agent's colour", () => {
  it("is the one its name gives it, on the map, in the needs list and on its card, until it chooses", async () => {
    await everywhere();
    const own = agentColor("planner");
    expect(dots()).toEqual({ map: css(own), needs: own, card: css(own) });
  });

  it("is the one it chose for its body, everywhere, and changes everywhere when it chooses again", async () => {
    bodies = [{ id: "planner", data: { color: "#e0457b" } }];
    await everywhere();
    expect(dots()).toEqual({ map: css("#e0457b"), needs: "#e0457b", card: css("#e0457b") });
    hear({ type: "body", id: "planner", op: "update", after: { color: "#2f9e8f" } } as Partial<StateChangeInfo>);
    expect(dots()).toEqual({ map: css("#2f9e8f"), needs: "#2f9e8f", card: css("#2f9e8f") });
    // Archived, its body is out of effect: the name's colour, until it is restored.
    const archive = (lifecycle: "archived" | "unarchived") =>
      hear({ type: "body", id: "planner", op: "update", after: { color: "#2f9e8f" }, lifecycle });
    archive("archived");
    expect(dots().card).toBe(css(agentColor("planner")));
    archive("unarchived");
    expect(dots().card).toBe(css("#2f9e8f"));
    // Back to its own: the name's again.
    hear({ type: "body", id: "planner", op: "delete" } as Partial<StateChangeInfo>);
    expect(dots().card).toBe(css(agentColor("planner")));
  });

  it("is no colour in the needs list for the default agent, whose body keeps the model's own colours", async () => {
    await act(async () =>
      root.render(
        <NeedsList
          needs={[{ ...need, agent: "default" }]}
          whereOf={() => undefined}
          onOpen={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    expect((container.querySelector(".world-needs-who") as HTMLElement).style.getPropertyValue("--who")).toBe("");
  });
});
