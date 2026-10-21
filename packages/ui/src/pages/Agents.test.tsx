/**
 * The Agents page with the directory: the list shows each agent's purpose and
 * its open and waiting work, opening an agent shows its page first with the
 * settings a click away, and with the directory off it reads as before, with
 * the configured description and a hint.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agents } from "./Agents";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static last: FakeEventSource | undefined;
  listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(event: string, fn: (ev: { data: string }) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }
  emit(event: string, data: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn({ data: JSON.stringify(data) });
  }
  close() {}
}

const configured = {
  "trip-planner": { description: "Plans trips.", tools: ["directory", "commitment"] },
  chef: { description: "Suggests recipes." },
};

let summaries: unknown[];
let directoryOn: boolean;
let directoryBroken: boolean;
let watchers: Record<string, unknown>[];
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  directoryOn = true;
  directoryBroken = false;
  watchers = [];
  summaries = [
    {
      name: "chef",
      profile: null,
      description: "Suggests recipes.",
      commitments: { open: 0, waiting: 0, done: 0 },
      docs: 0,
    },
    {
      name: "trip-planner",
      profile: { owner: "trip-planner", purpose: "Plans trips end to end." },
      description: "Plans trips.",
      commitments: { open: 2, waiting: 1, done: 4 },
      docs: 2,
    },
  ];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url === "/api/agents") return json(configured);
      if (url === "/api/exploratory/agents") return json({ enabled: true, activity: null, agents: watchers });
      if (url.startsWith("/api/ext/builtin:directory/")) {
        // Off: the route isn't mounted, and the server's page fallback answers with the UI.
        if (!directoryOn) return new Response("<!doctype html>", { status: 200 });
        if (directoryBroken) return new Response("Internal Server Error", { status: 500 });
        if (url.endsWith("/agents")) return json({ agents: summaries });
        return json({
          name: "trip-planner",
          profile: null,
          description: "Plans trips.",
          page: null,
          commitments: [],
          docs: [],
          misses: [],
        });
      }
      if (url.startsWith("/api/sessions")) return json([]);
      if (url.startsWith("/api/task-comments")) return json({ comments: [] });
      if (url.startsWith("/api/projects") || url.startsWith("/api/tasks")) return json({ tasks: [], total: 0 });
      return json({}, 404);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: { agentName?: string; view?: "settings" } = {}) {
  await act(async () => {
    root.render(<Agents {...props} />);
  });
  await act(async () => {});
  await act(async () => {});
}

const cards = () =>
  [...container.querySelectorAll(".agent-overview-card")].map((c) => ({
    name: c.querySelector(".agent-overview-name")?.textContent,
    purpose: c.querySelector(".agent-overview-purpose")?.textContent,
    counts: c.querySelector(".agent-overview-counts")?.textContent ?? null,
  }));

describe("the agent list", () => {
  it("shows each agent's purpose line and its open and waiting work", async () => {
    await render();
    expect(cards()).toEqual([
      { name: "chef", purpose: "Suggests recipes.", counts: "0 open0 waiting0 docs" },
      { name: "trip-planner", purpose: "Plans trips end to end.", counts: "2 open1 waiting2 docs" },
    ]);
    // The sidebar, beside an open agent, says the same in a line.
    await render({ agentName: "chef" });
    const side = [...container.querySelectorAll(".agents-sidebar-item")].find((i) =>
      i.textContent?.includes("trip-planner"),
    );
    expect(side?.querySelector(".agents-sidebar-purpose")?.textContent).toBe("Plans trips end to end.");
    expect(side?.querySelector(".agents-sidebar-counts")?.textContent).toBe("2 open · 1 waiting");
    // The same line whether or not it has work: the counts come after the tools, and only waiting is picked out.
    expect(side?.querySelector(".agents-sidebar-sub")?.textContent).toBe("2 tools · 2 open · 1 waiting");
    expect(side?.querySelector(".agents-sidebar-counts .waiting")?.textContent).toBe("1 waiting");
    const chef = [...container.querySelectorAll(".agents-sidebar-item")].find((i) => i.textContent?.includes("chef"));
    expect(chef?.querySelector(".agents-sidebar-sub")?.textContent).toBe("0 tools");
  });

  it("shows each watcher's state and today's runs on its card", async () => {
    watchers = [
      {
        name: "chef",
        enabled_in_state: true,
        paused_until: new Date(Date.now() + 3_600_000).toISOString(),
        last_tick_status: "ok",
        runs_today: 3,
        tokens_today: 1200,
      },
    ];
    await render();
    const card = (name: string) =>
      [...container.querySelectorAll(".agent-overview-card")].find(
        (c) => c.querySelector(".agent-overview-name")?.textContent === name,
      );
    expect(card("chef")?.querySelector(".agent-state")?.textContent).toBe("paused");
    expect(card("chef")?.querySelector(".agent-overview-runs")?.textContent).toBe("3 runs · 1,200 tok today");
    expect(card("trip-planner")?.querySelector(".agent-state")).toBeNull();
  });

  it("doesn't take a failing directory for one that's off", async () => {
    directoryBroken = true;
    await render();
    expect(container.textContent).not.toContain("Turn on the directory");
    await render({ agentName: "trip-planner" });
    expect(container.querySelector(".agent-detail-tabs")).not.toBeNull();
    expect(container.textContent).toContain("Couldn't load the page: 500");
  });

  it("keeps the counts current as commitments change", async () => {
    await render();
    summaries = [summaries[0], { ...(summaries[1] as object), commitments: { open: 3, waiting: 0, done: 4 } }];
    await act(async () =>
      FakeEventSource.last?.emit("change", {
        type: "commitment",
        id: "x",
        op: "update",
        after: { owner: "trip-planner" },
      }),
    );
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(cards()[1].counts).toBe("3 open0 waiting2 docs");
  });

  it("shows configured descriptions and how to turn the directory on, with it off", async () => {
    directoryOn = false;
    await render();
    expect(cards()).toEqual([
      { name: "chef", purpose: "Suggests recipes.", counts: null },
      { name: "trip-planner", purpose: "Plans trips.", counts: null },
    ]);
    expect(container.textContent).toContain("Turn on the directory");
  });
});

describe("opening an agent", () => {
  it("shows its page first, with its settings one click away", async () => {
    await render({ agentName: "trip-planner" });
    const tabs = [...container.querySelectorAll(".agent-detail-tabs a")] as HTMLAnchorElement[];
    expect(tabs.map((t) => [t.textContent, t.getAttribute("href"), t.getAttribute("aria-current")])).toEqual([
      ["Page", "#/agents/trip-planner", "page"],
      ["Settings", "#/agents/trip-planner/settings", null],
    ]);
    expect(container.querySelector(".agent-page")).not.toBeNull();
    expect(container.textContent).not.toContain("Configuration");

    await render({ agentName: "trip-planner", view: "settings" });
    expect(container.querySelector(".agent-page")).toBeNull();
    expect(container.textContent).toContain("Configuration");
  });

  it("with the directory off, shows the description, a hint and the settings as before", async () => {
    directoryOn = false;
    await render({ agentName: "trip-planner" });
    expect(container.querySelector(".agent-detail-tabs")).toBeNull();
    expect(container.querySelector(".agent-page-about")?.textContent).toContain("Plans trips.");
    expect(container.textContent).toContain("Turn on the directory");
    expect(container.textContent).toContain("Configuration");
  });
});
