/**
 * The page the server's camera photographs: the stage alone, holding still
 * where it was asked to, saying when the frame is ready or why it can't be.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Snapshot } from "./Snapshot";

const stage = vi.hoisted(() => ({
  opts: [] as {
    view?: string;
    still?: { spot?: string; gesture?: string };
    room?: { name?: string };
    lights?: string;
  }[],
}));
vi.mock("../avatar/stage", () => ({
  createStage: async (
    _host: HTMLElement,
    _url: string,
    _input: unknown,
    opts: {
      view?: string;
      still?: { spot?: string; gesture?: string };
      room?: { name?: string };
      onReady?: () => void;
    },
  ) => {
    stage.opts.push(opts);
    setTimeout(() => opts.onReady?.(), 0);
    return {
      dispose() {},
      setView() {},
      setInsets() {},
      setRoom() {},
      setCompany() {},
      setWear() {},
      setLights() {},
      cue() {},
      onSurfaces: () => () => {},
    };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let live: Record<string, unknown>;

beforeEach(() => {
  stage.opts.length = 0;
  live = { enabled: true, avatar: "/api/live/avatar?agent=guide" };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith("/api/live")) return new Response(JSON.stringify(live));
      if (url === "/api/ext/builtin:places/guide")
        return new Response(
          JSON.stringify({
            id: "home:guide",
            place: { name: "guide's room", props: [], spots: [], start: "middle" },
            wear: ["beret", "scarf"],
          }),
        );
      if (url === "/api/ext/builtin:places/planner")
        return new Response(
          JSON.stringify({ id: "room:local:trip", place: { name: "trip", props: [], spots: [], start: "middle" } }),
        );
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/**
 * Open the page and wait until it says whether it can be photographed: short
 * turns until it does, rather than a fixed sleep a slow runner outlasts.
 */
async function open(hash: string) {
  window.location.hash = hash;
  await act(async () => root.render(<Snapshot />));
  const settled = () => ["ready", "failed"].includes(frame()?.dataset.snapshot ?? "");
  for (let waited = 0; !settled() && waited < 3000; waited += 10)
    await act(async () => new Promise((r) => setTimeout(r, 10)));
}

const frame = () => container.querySelector("[data-snapshot]") as HTMLElement;

describe("the snapshot page", () => {
  it("holds the avatar still where it was asked, in the agent's room, and says when it's ready", async () => {
    await open("/snapshot?agent=guide&view=selfie&spot=couch&gesture=wave");
    expect(stage.opts[0]).toMatchObject({
      view: "close",
      still: { spot: "couch", gesture: "wave" },
      room: { name: "guide's room" },
      lights: "home",
      // In its own colours, wearing what it wears in the world.
      agent: "guide",
      wear: ["beret", "scarf"],
    });
    expect(frame().dataset.snapshot).toBe("ready");
    // Nothing to click in a photo.
    expect(container.querySelector(".talk-view")).toBeNull();
  });

  it("lights a photo in a meeting room as anyone walking in sees it, bright after dark", async () => {
    live = { enabled: true, avatar: "/api/live/avatar?agent=planner" };
    await open("/snapshot?agent=planner");
    expect(stage.opts[0]).toMatchObject({ room: { name: "trip" }, lights: "public" });
  });

  it("says why when there's nothing to photograph", async () => {
    live = { enabled: true };
    await open("/snapshot?agent=guide");
    expect(frame().dataset.snapshot).toBe("failed");
    expect(frame().textContent).toMatch(/guide has no avatar/);
  });
});
