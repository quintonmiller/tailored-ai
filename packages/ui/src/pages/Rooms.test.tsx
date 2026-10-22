/**
 * Rooms: the list of every live room with its lead, purpose and counts, and
 * a room's page drawn from the directory's records: what it's for, who leads
 * it and who's in it, its work, what a person set, handing its lead
 * something, changing the lead, and keeping up with the state stream.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Rooms } from "./Rooms";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no EventSource; this one lets a test push events. */
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

const NOW = new Date();
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const TRAVEL = "local:travel";

let n = 0;
function rec(type: string, id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  n++;
  return {
    type,
    id,
    scope: `room:${TRAVEL}`,
    data: { room: TRAVEL, ...data },
    version: 1,
    createdAt: hoursAgo(100 - n),
    updatedAt: hoursAgo(1),
    updatedBy: { kind: "plugin", name: "directory" },
    ...extra,
  };
}

function travel() {
  return {
    ref: TRAVEL,
    name: "travel",
    purpose: "Family trips.",
    createdBy: "alex",
    archived: false,
    profile: rec(
      "profile",
      `room:${TRAVEL}`,
      {
        owner: `room:${TRAVEL}`,
        purpose: "Family trips, from first idea to bookings.",
        note: "Ask us before you book.",
        takesOn: ["flights", "ferries"],
      },
      { scope: "global" },
    ) as Record<string, unknown> | null,
    lead: { agent: "trip-planner", source: "config" } as Record<string, unknown>,
    members: ["planner", "trip-planner"],
    agents: ["planner", "trip-planner", "writer"],
    commitments: [
      rec("commitment", "room-travel-ferry", {
        owner: `room:${TRAVEL}`,
        goal: "Ferry tickets",
        status: "open",
        nextStep: "Wait for the timetable",
        doneWhen: "Tickets in the inbox",
        updates: [
          { at: hoursAgo(2), text: 'A person set the next step to "Wait for the timetable".', by: "a person" },
          { at: hoursAgo(20), text: "Opened.", by: "planner" },
        ],
      }),
      rec(
        "commitment",
        "trip-planner-dog-sitter",
        { owner: "trip-planner", goal: "Find a dog sitter", status: "open", from: "a person" },
        { scope: "global", updatedAt: hoursAgo(5) },
      ),
      rec("commitment", "room-travel-visa", {
        owner: `room:${TRAVEL}`,
        goal: "Visa forms",
        status: "waiting",
        waitingOn: "passport photos",
      }),
      rec("commitment", "room-travel-hotel", {
        owner: `room:${TRAVEL}`,
        goal: "Hotel in Lisbon",
        status: "done",
        updates: [{ at: hoursAgo(26), text: "Done.", by: "trip-planner" }],
      }),
    ],
    docs: [
      rec("doc", "room-travel-packing", {
        owner: `room:${TRAVEL}`,
        title: "Packing list",
        summary: "What the family packs.",
        body: "- Passports",
        reviewedAt: hoursAgo(48),
      }),
    ],
    misses: [
      rec("miss", "miss-1", {
        owner: `room:${TRAVEL}`,
        query: "ferry timetable",
        askedBy: ["writer"],
        at: hoursAgo(3),
      }),
    ],
    held: { "room-travel-ferry": ["nextStep"], [`room:${TRAVEL}`]: ["purpose"] } as Record<string, string[]>,
  };
}

const summaries = () => [
  {
    ref: "local:garden",
    name: "garden",
    purpose: null,
    lead: null,
    members: [],
    commitments: { open: 0, waiting: 0, done: 0 },
    docs: 0,
  },
  {
    ref: TRAVEL,
    name: "travel",
    purpose: "Family trips, from first idea to bookings.",
    lead: "trip-planner",
    leadFrom: "config",
    members: ["planner", "trip-planner"],
    commitments: { open: 2, waiting: 1, done: 1 },
    docs: 1,
  },
];

let root: Root;
let container: HTMLDivElement;
let room: ReturnType<typeof travel>;
let list: ReturnType<typeof summaries>;
let off: boolean;
/** What the server answers with the directory off: a plain 404, or the plugin routes' own JSON one. */
let offBody: string;
let roomReads: number;
const calls: { method: string; url: string; body?: unknown }[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  room = travel();
  list = summaries();
  off = false;
  offBody = "Not Found";
  roomReads = 0;
  calls.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (off) return new Response(offBody, { status: 404 });
      const path = url.replace("/api/ext/builtin:directory/", "");
      if (path === "rooms") return new Response(JSON.stringify({ rooms: list }));
      if (path === "rooms/attic") {
        return new Response(JSON.stringify({ error: 'There\'s no room called "attic".', room: "attic" }), {
          status: 404,
        });
      }
      if (method === "GET" && path === "rooms/travel") {
        roomReads++;
        return new Response(JSON.stringify(room));
      }
      if (method === "POST" && path === "rooms/travel/commitments") {
        return new Response(JSON.stringify({ commitment: { id: "x" }, lead: "trip-planner", inPrompt: true }), {
          status: 201,
        });
      }
      if (method === "PUT" && path === "rooms/travel/lead") {
        return new Response(JSON.stringify({ lead: { agent: "writer", source: "person" } }));
      }
      if (method === "PATCH") return new Response(JSON.stringify({}));
      return new Response(JSON.stringify({}), { status: 404 });
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(roomName?: string) {
  await act(async () => {
    root.render(<Rooms roomName={roomName} />);
  });
  await act(async () => {});
}

const section = (label: string) => container.querySelector(`section[aria-label="${label}"]`) as HTMLElement;
const settle = () => act(() => new Promise((r) => setTimeout(r, 200)));
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function pick(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the rooms list", () => {
  it("shows every room with what it's for, who leads it and where from, its members and its counts", async () => {
    await render();
    const cards = [...container.querySelectorAll(".room-card")] as HTMLAnchorElement[];
    expect(cards.map((c) => c.getAttribute("href"))).toEqual(["#/rooms/garden", "#/rooms/travel"]);
    const travelCard = cards[1];
    expect(travelCard.querySelector(".agent-overview-name")?.textContent).toBe("#travel");
    expect(travelCard.textContent).toContain("Family trips, from first idea to bookings.");
    expect(travelCard.querySelector(".room-card-lead")?.textContent).toBe("Led by trip-planner · named in config");
    expect(travelCard.querySelector(".room-card-members")?.textContent).toBe("2 members");
    expect(travelCard.querySelector(".agent-overview-counts")?.textContent).toBe("2 open1 waiting1 doc");
    expect(travelCard.querySelector(".waiting")?.textContent).toBe("1 waiting");
    // A room nobody leads, or that hasn't said what it's for, says so.
    expect(cards[0].textContent).toContain("Nobody has said what it's for yet.");
    expect(cards[0].textContent).toContain("No lead yet");
  });

  it("says how to turn the directory on when it's off", async () => {
    off = true;
    await render();
    expect(container.textContent).toContain("Turn on the directory");
  });

  it("says how to turn the directory on from a room's page, whatever 404 the server gives with it off", async () => {
    off = true;
    // The server answers a plugin path nobody serves with JSON, and a reload mid-request says it's turned off.
    for (const body of [{ error: "not_found" }, { error: "The directory is turned off." }]) {
      offBody = JSON.stringify(body);
      await render("travel");
      expect(container.textContent).toContain("Turn on the directory");
      expect(container.textContent).not.toContain("Couldn't load the room");
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it("reads itself again when a room's records change", async () => {
    await render();
    const before = calls.filter((c) => c.url.endsWith("/rooms")).length;
    act(() => FakeEventSource.last?.emit("change", { type: "commitment", id: "x", after: { room: TRAVEL } }));
    await settle();
    expect(calls.filter((c) => c.url.endsWith("/rooms")).length).toBe(before + 1);
  });
});

describe("a room's page", () => {
  it("says what it's for, in its members' words, and marks what a person set", async () => {
    await render("travel");
    const about = section("What it's for");
    expect(about.querySelector(".agent-page-purpose")?.textContent).toContain(
      "Family trips, from first idea to bookings.",
    );
    expect(about.querySelector(".agent-page-purpose .room-held")?.textContent).toBe("set by you");
    expect(about.querySelector("blockquote")?.textContent).toBe("Ask us before you book.");
    expect(about.textContent).toContain("In its members' words");
    expect(about.querySelector("figcaption .room-held")).toBeNull();
    expect([...about.querySelectorAll(".agent-tool-chip")].map((c) => c.textContent)).toEqual(["flights", "ferries"]);
  });

  it("says a note a person wrote is in their words, not its members'", async () => {
    room = { ...travel(), held: { [`room:${TRAVEL}`]: ["note"] } };
    await render("travel");
    const caption = section("What it's for").querySelector("figcaption") as HTMLElement;
    expect(caption.textContent).toBe("In your words set by you");
    expect(caption.textContent).not.toContain("members");
  });

  it("falls back to the purpose the room was given, marked as such, when nobody wrote its profile", async () => {
    room = { ...travel(), profile: null };
    await render("travel");
    const about = section("What it's for");
    expect(about.textContent).toContain("Family trips.");
    expect(about.textContent).toContain("The purpose it was given");
  });

  it("names its lead, where that came from, and its members, and changes the lead", async () => {
    await render("travel");
    const people = section("Lead and members");
    expect(people.querySelector(".room-lead-name")?.textContent).toBe("trip-planner");
    expect(people.querySelector(".room-lead .agent-page-meta")?.textContent).toBe("named in config");
    expect([...people.querySelectorAll(".agent-page-chips a")].map((a) => a.textContent)).toEqual([
      "planner",
      "trip-planner · lead",
    ]);
    const select = people.querySelector("select") as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe("trip-planner (config)");
    await act(async () => pick(select, "writer"));
    await act(async () => {});
    expect(calls.find((c) => c.method === "PUT")).toEqual({
      method: "PUT",
      url: "/api/ext/builtin:directory/rooms/travel/lead",
      body: { lead: "writer" },
    });
  });

  it("says who handing a person's choice back gives: config's lead, the room's creator, or nobody", async () => {
    const first = async (lead: Record<string, unknown>) => {
      room = { ...travel(), lead };
      await render("travel");
      const text = (section("Lead and members").querySelector("select option") as HTMLOptionElement).textContent;
      act(() => root.unmount());
      root = createRoot(container);
      return text;
    };
    const chosen = { agent: "writer", source: "person" };
    expect(
      await first({ ...chosen, configured: "trip-planner", fallback: { agent: "trip-planner", source: "config" } }),
    ).toBe("Back to trip-planner, named in config");
    expect(await first({ ...chosen, fallback: { agent: "planner", source: "creator" } })).toBe(
      "Back to planner, who made the room",
    );
    expect(await first(chosen)).toBe("Back to nobody");
  });

  it("shows its work: its own and its lead's for it, what a person set, who wrote each update, and what's waiting", async () => {
    await render("travel");
    const working = section("Working on");
    const items = [...working.querySelectorAll(".agent-page-item")];
    expect(items.map((i) => i.querySelector(".agent-page-goal > span")?.textContent)).toEqual([
      "Ferry tickets",
      "Find a dog sitter",
    ]);
    const ferry = items[0];
    expect(ferry.textContent).toContain("Next Wait for the timetable");
    expect(ferry.querySelector(".agent-page-line .room-held")?.textContent).toBe("set by you");
    expect([...ferry.querySelectorAll(".agent-page-by")].map((b) => b.textContent)).toEqual([
      " · a person",
      " · planner",
    ]);
    expect(items[1].querySelector(".agent-page-meta")?.textContent).toContain("taken on by trip-planner");
    expect(items[1].querySelector(".agent-page-meta")?.textContent).toContain("from a person");

    const waiting = section("Waiting on you");
    expect(waiting.textContent).toContain("Waiting on passport photos");
    expect(section("Recent results").textContent).toContain("Hotel in Lisbon");
    expect(section("Docs").textContent).toContain("Packing list");
    expect(section("Questions nobody could answer").textContent).toContain("ferry timetable");
  });

  it("lets a person change a commitment's next step and status, as them", async () => {
    await render("travel");
    const ferry = section("Working on").querySelector(".agent-page-item") as HTMLElement;
    await act(async () => (ferry.querySelector(".room-edit") as HTMLButtonElement).click());
    const form = ferry.querySelector("form") as HTMLFormElement;
    await act(async () => type(form.querySelector("input") as HTMLInputElement, "Book the early boat"));
    await act(async () => pick(form.querySelector("select") as HTMLSelectElement, "done"));
    await act(async () => form.requestSubmit());
    await act(async () => {});
    expect(calls.find((c) => c.method === "PATCH")).toEqual({
      method: "PATCH",
      url: "/api/ext/builtin:directory/rooms/travel/commitments/room-travel-ferry",
      body: { nextStep: "Book the early boat", status: "done" },
    });
  });

  it("marks what a person set on a commitment its lead took on for it, the same as on the room's own", async () => {
    room = { ...travel(), held: { "trip-planner-dog-sitter": ["nextStep"] } };
    room.commitments = room.commitments.map((c) =>
      c.id === "trip-planner-dog-sitter" ? { ...c, data: { ...c.data, nextStep: "Ask Sam" } } : c,
    );
    await render("travel");
    const sitter = [...section("Working on").querySelectorAll(".agent-page-item")].find((i) =>
      i.textContent?.includes("Find a dog sitter"),
    ) as HTMLElement;
    expect(sitter.querySelector(".agent-page-line")?.textContent).toBe("Next Ask Sam set by you");
    await act(async () => (sitter.querySelector(".room-edit") as HTMLButtonElement).click());
    // The form says what holds and what doesn't.
    expect(sitter.querySelector("form")?.textContent).toContain(
      "Agents leave the next step and what it waits on as you set them; clear one to hand it back.",
    );
  });

  it("lets a person change what it's for and its note", async () => {
    await render("travel");
    const about = section("What it's for");
    await act(async () => (about.querySelector(".room-edit") as HTMLButtonElement).click());
    const form = about.querySelector("form") as HTMLFormElement;
    await act(async () => type(form.querySelector("input") as HTMLInputElement, "Ask before booking anything."));
    await act(async () => form.requestSubmit());
    await act(async () => {});
    expect(calls.find((c) => c.method === "PATCH")).toEqual({
      method: "PATCH",
      url: "/api/ext/builtin:directory/rooms/travel/profile",
      body: { note: "Ask before booking anything." },
    });
  });

  it("hands its lead something, and says nobody can be handed anything when it has no lead", async () => {
    await render("travel");
    const hand = section("Hand it something");
    expect(hand.textContent).toContain("It goes to trip-planner, who leads #travel");
    const goal = hand.querySelector("input") as HTMLInputElement;
    await act(async () => type(goal, "Find a dog sitter"));
    await act(async () => (hand.querySelector("form") as HTMLFormElement).requestSubmit());
    await act(async () => {});
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      url: "/api/ext/builtin:directory/rooms/travel/commitments",
      body: { goal: "Find a dog sitter" },
    });
    expect(hand.textContent).toContain("Handed to trip-planner: “Find a dog sitter”.");

    act(() => root.unmount());
    root = createRoot(container);
    room = { ...travel(), lead: {} };
    await render("travel");
    expect(section("Hand it something").textContent).toContain("This room has no lead to hand things to.");
    expect(section("Lead and members").textContent).toContain("Nobody leads it yet.");
  });

  it("keeps up with its records from the state stream, and leaves out other rooms' changes", async () => {
    await render("travel");
    const reads = roomReads;
    act(() => FakeEventSource.last?.emit("change", { type: "commitment", id: "y", after: { room: "local:garden" } }));
    await settle();
    expect(roomReads).toBe(reads);
    room = {
      ...travel(),
      commitments: [
        ...travel().commitments,
        rec("commitment", "room-travel-new", { goal: "Car hire", status: "open" }),
      ],
    };
    act(() =>
      FakeEventSource.last?.emit("change", { type: "commitment", id: "room-travel-new", after: { room: TRAVEL } }),
    );
    await settle();
    expect(roomReads).toBe(reads + 1);
    expect(section("Working on").textContent).toContain("Car hire");
  });

  it("says when there's no such room, rather than that the directory is off", async () => {
    await render("attic");
    expect(container.textContent).toContain("Couldn't load the room: There's no room called \"attic\".");
  });
});
