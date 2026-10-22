/**
 * An agent's page: each section drawn from the directory's records, in the
 * order the agent chose; a section it added, bound to its query; the page
 * with the directory off; handing it something; and the page keeping up with
 * changes from the state stream without a reload.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPage } from "./AgentPage";

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

let n = 0;
function rec(type: string, id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  n++;
  return {
    type,
    id,
    scope: "global",
    data,
    version: 1,
    createdAt: hoursAgo(100 - n),
    updatedAt: hoursAgo(1),
    updatedBy: { kind: "plugin", name: "directory" },
    ...extra,
  };
}

function tripPlanner() {
  return {
    name: "trip-planner",
    description: "Plans trips.",
    profile: rec("profile", "trip-planner", {
      owner: "trip-planner",
      purpose: "Plans trips end to end.",
      takesOn: ["trip research", "bookings with approval"],
      howToAsk: "Hand it a commitment.",
    }),
    page: null as unknown,
    commitments: [
      rec("commitment", "trip-planner-lisbon", {
        owner: "trip-planner",
        goal: "Lisbon trip",
        doneWhen: "Hotel booked",
        status: "open",
        nextStep: "Shortlist hotels",
        nextCheck: "Friday",
        autonomy: "suggest",
        progress: { value: 3, max: 5 },
        updates: [
          { at: hoursAgo(2), text: "Found three hotels." },
          { at: hoursAgo(30), text: "Opened." },
        ],
      }),
      rec(
        "commitment",
        "trip-planner-gift",
        { owner: "trip-planner", goal: "Anniversary gift", status: "open", progress: "drafting" },
        { scope: "agent:trip-planner", updatedAt: hoursAgo(10) },
      ),
      rec("commitment", "trip-planner-hotel", {
        owner: "trip-planner",
        goal: "Pick a hotel",
        status: "waiting",
        waitingOn: "you to pick one",
        updates: [{ at: hoursAgo(5), text: "Waiting on you to pick one." }],
      }),
      rec("commitment", "trip-planner-transfer", {
        owner: "trip-planner",
        goal: "Airport transfer",
        status: "done",
        updates: [{ at: hoursAgo(26), text: "Done: Booked both ways." }],
      }),
      rec("commitment", "trip-planner-old", {
        owner: "trip-planner",
        goal: "Last spring's trip",
        status: "done",
        updates: [{ at: hoursAgo(24 * 40), text: "Done." }],
      }),
      rec("commitment", "trip-planner-dropped", { owner: "trip-planner", goal: "Ski week", status: "dropped" }),
    ],
    docs: [
      rec("doc", "trip-planner-prefs", {
        owner: "trip-planner",
        title: "Travel preferences",
        summary: "Window seats, no red-eyes.",
        body: "## Flights\n\n- Window seat\n\n<img src=x onerror=alert(1)>",
        tags: ["travel"],
        reviewedAt: hoursAgo(48),
      }),
      rec("doc", "trip-planner-checklist", { owner: "trip-planner", title: "Booking checklist" }),
    ],
    misses: [
      rec(
        "miss",
        "miss-1",
        { owner: "trip-planner", query: "ski chalet bookings", askedBy: ["writer", "planner"], at: hoursAgo(3) },
        { scope: "agent:trip-planner" },
      ),
      rec(
        "miss",
        "miss-2",
        { owner: "trip-planner", query: "last month's question", askedBy: ["writer"], at: hoursAgo(24 * 30) },
        { scope: "agent:trip-planner" },
      ),
    ],
  };
}

let root: Root;
let container: HTMLDivElement;
let agent: ReturnType<typeof tripPlanner> | null;
let directoryOff: "404" | "html" | null;
let directoryBroken: boolean;
let hotels: Record<string, unknown>[];
let hotelsRead: "ok" | "fail" | Promise<void>;
let handStatus: number;
let handWhy: string | undefined;
let upkeepAnswer: { status: number; body: unknown };
let patchAnswer: { status: number; body?: unknown };
const calls: { method: string; url: string; body?: unknown }[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  agent = tripPlanner();
  directoryOff = null;
  directoryBroken = false;
  hotelsRead = "ok";
  handStatus = 201;
  handWhy = undefined;
  upkeepAnswer = { status: 202, body: { started: true } };
  patchAnswer = { status: 200 };
  hotels = [
    rec("hotel", "tejo", { name: "Lisboa Tejo", price: 122, shortlisted: true }),
    rec("hotel", "memmo", { name: "Memmo Alfama", price: 178, shortlisted: true }),
    rec("hotel", "elsewhere", { name: "Someone else's", price: 90, shortlisted: true }, { scope: "agent:planner" }),
  ];
  calls.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.startsWith("/api/ext/builtin:directory/")) {
        if (directoryOff === "404") return new Response("Not Found", { status: 404 });
        if (directoryOff === "html") return new Response("<!doctype html><html></html>", { status: 200 });
        // A store that threw: the server's plain-text 500, not JSON.
        if (directoryBroken) return new Response("Internal Server Error", { status: 500 });
        if (method === "POST" && url.endsWith("/upkeep")) {
          return new Response(JSON.stringify(upkeepAnswer.body), { status: upkeepAnswer.status });
        }
        if (method === "POST") {
          if (handStatus !== 201)
            return new Response(JSON.stringify({ error: "Say what you're handing over." }), { status: handStatus });
          const answer = {
            commitment: { id: "trip-planner-new" },
            inPrompt: !handWhy,
            ...(handWhy ? { why: handWhy } : {}),
          };
          return new Response(JSON.stringify(answer), { status: 201 });
        }
        return new Response(JSON.stringify(agent), { status: 200 });
      }
      if (method === "PATCH" && url.startsWith("/api/state/commitment/")) {
        if (patchAnswer.status !== 200) {
          return new Response(JSON.stringify(patchAnswer.body), { status: patchAnswer.status });
        }
        return new Response(JSON.stringify({ ...agent?.commitments[0], version: 2 }));
      }
      if (url.startsWith("/api/state/types")) {
        return new Response(JSON.stringify({ types: [{ name: "hotel", title: "name", canWrite: true }] }));
      }
      if (url.startsWith("/api/state/hotel")) {
        if (hotelsRead === "fail") return new Response(JSON.stringify({ error: "No such type." }), { status: 400 });
        if (hotelsRead !== "ok") await hotelsRead;
        return new Response(JSON.stringify({ records: hotels }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(name = "trip-planner", description = "Plans trips.") {
  await act(async () => {
    root.render(<AgentPage name={name} description={description} />);
  });
  await act(async () => {});
}

const section = (label: string) => container.querySelector(`section[aria-label="${label}"]`) as HTMLElement | null;
/** A line's text as a person reads it: a select says the option it shows, not every option it has. */
function readText(el: Element | null | undefined): string | undefined {
  if (!el) return undefined;
  const copy = el.cloneNode(true) as Element;
  for (const select of copy.querySelectorAll("select")) {
    const original = el.querySelector(`select[aria-label="${select.getAttribute("aria-label")}"]`) as HTMLSelectElement;
    select.replaceWith(original.selectedOptions[0]?.textContent ?? "");
  }
  return copy.textContent ?? undefined;
}
const headings = () => [...container.querySelectorAll("section > h2")].map((h) => h.childNodes[0]?.textContent);
const settle = () => act(() => new Promise((r) => setTimeout(r, 200)));

/** trip-planner with one section of its own: a hotel shortlist, first. */
function withShortlist() {
  return {
    ...tripPlanner(),
    page: rec("page", "trip-planner", {
      owner: "trip-planner",
      order: ["hotel-shortlist"],
      extra: [
        {
          id: "hotel-shortlist",
          title: "Hotel shortlist",
          query: {
            type: "hotel",
            where: { shortlisted: true },
            orderBy: "price",
            limit: 5,
            scopes: ["agent:trip-planner", "global"],
          },
        },
      ],
    }),
  };
}

describe("an agent's page", () => {
  it("says what it's for: purpose, its note in its own words, what it takes on and how to ask", async () => {
    agent = { ...tripPlanner(), page: rec("page", "trip-planner", { owner: "trip-planner", note: "I ask first." }) };
    await render();
    const about = section("What I'm for") as HTMLElement;
    expect(about.textContent).toContain("Plans trips end to end.");
    expect(about.querySelector("blockquote")?.textContent).toBe("I ask first.");
    expect(about.textContent).toContain("In its own words");
    expect([...about.querySelectorAll(".agent-tool-chip")].map((c) => c.textContent)).toEqual([
      "trip research",
      "bookings with approval",
    ]);
    expect(about.textContent).toContain("Hand it a commitment.");
  });

  it("falls back to the configured description, marked as such, when there's no profile", async () => {
    agent = { ...tripPlanner(), profile: null as never };
    await render();
    const about = section("What I'm for") as HTMLElement;
    expect(about.textContent).toContain("Plans trips.");
    expect(about.textContent).toContain("Its configured description: it hasn't written a profile yet.");
  });

  it("shows open work with next step, done-when, progress, check, autonomy and age, and the dated updates", async () => {
    await render();
    const working = section("Working on") as HTMLElement;
    const items = [...working.querySelectorAll(".agent-page-item")];
    expect(items.map((i) => i.querySelector(".agent-page-goal")?.textContent)).toEqual([
      "Lisbon trip",
      "Anniversary giftprivate",
    ]);
    const lisbon = items[0];
    expect(lisbon.textContent).toContain("Next Shortlist hotels");
    expect(lisbon.textContent).toContain("Done when Hotel booked");
    expect(lisbon.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("60");
    expect(lisbon.textContent).toContain("3 of 5 (60%)");
    expect(readText(lisbon.querySelector(".agent-page-meta"))).toBe("check Friday · asks first · updated 2h ago");
    expect(lisbon.querySelector("summary")?.textContent).toBe("2 updates");
    expect([...lisbon.querySelectorAll(".agent-page-updates li span")].map((s) => s.textContent)).toEqual([
      "Found three hotels.",
      "Opened.",
    ]);
    // A step label is said, not drawn as a bar.
    expect(items[1].textContent).toContain("At drafting");
    expect(items[1].querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows what's waiting on you, with what it waits on", async () => {
    await render();
    const waiting = section("Waiting on you") as HTMLElement;
    expect(waiting.querySelector(".agent-page-count")?.textContent).toBe("1");
    expect(waiting.textContent).toContain("Pick a hotel");
    expect(waiting.textContent).toContain("Waiting on you to pick one");
    expect(waiting.textContent).toContain("since 5h ago");
  });

  it("shows what it finished in the last two weeks, with dates, and nothing older or dropped", async () => {
    await render();
    const results = section("Recent results") as HTMLElement;
    expect([...results.querySelectorAll(".agent-page-goal > span:nth-child(2)")].map((s) => s.textContent)).toEqual([
      "Airport transfer",
    ]);
    expect(results.querySelector("time")?.getAttribute("dateTime")).toBe(
      (agent?.commitments[3].data.updates as { at: string }[])[0].at,
    );
    expect(results.textContent).toContain("Done: Booked both ways.");
    expect(container.textContent).not.toContain("Last spring's trip");
    expect(container.textContent).not.toContain("Ski week");
  });

  it("lists docs with summary and review date, and opens one in place, sanitized", async () => {
    await render();
    const docs = section("Docs") as HTMLElement;
    const titles = [...docs.querySelectorAll(".agent-page-doc-title")] as HTMLButtonElement[];
    expect(titles.map((t) => t.firstChild?.textContent)).toEqual(["Travel preferences", "Booking checklist"]);
    expect(titles[0].textContent).toContain("reviewed");
    expect(titles[1].textContent).toContain("never reviewed");
    expect(docs.textContent).toContain("Window seats, no red-eyes.");
    expect(docs.querySelector(".markdown-body")).toBeNull();

    await act(async () => titles[0].click());
    const body = docs.querySelector(".markdown-body") as HTMLElement;
    expect(body.querySelector("h2")?.textContent).toBe("Flights");
    expect(body.innerHTML).not.toContain("onerror");
    expect(titles[0].getAttribute("aria-expanded")).toBe("true");
    await act(async () => titles[0].click());
    expect(docs.querySelector(".markdown-body")).toBeNull();
  });

  it("shows questions nobody could answer from the last two weeks, and leaves the section out when there are none", async () => {
    await render();
    const misses = section("Questions nobody could answer") as HTMLElement;
    expect(misses.textContent).toContain("“ski chalet bookings”");
    expect(misses.textContent).toContain("asked by writer, planner");
    expect(misses.textContent).not.toContain("last month's question");

    act(() => root.unmount());
    root = createRoot(container);
    agent = { ...tripPlanner(), misses: [] };
    await render();
    expect(section("Questions nobody could answer")).toBeNull();
  });

  it("draws the sections in the order the agent chose, without the ones it hid", async () => {
    agent = {
      ...tripPlanner(),
      page: rec("page", "trip-planner", { owner: "trip-planner", order: ["waiting", "docs"], hide: ["results"] }),
    };
    await render();
    expect(headings()).toEqual([
      "Waiting on you",
      "Docs",
      "What I'm for",
      "Working on",
      "Questions nobody could answer",
      "Hand it something",
    ]);
  });

  it("draws a section the agent added as a list bound to its query, in its order and among its scopes", async () => {
    agent = withShortlist();
    await render();
    await act(async () => {});
    expect(headings()[0]).toBe("Hotel shortlist");
    const list = section("Hotel shortlist") as HTMLElement;
    expect([...list.querySelectorAll(".iface-list li")].map((l) => l.textContent)).toEqual([
      "Lisboa Tejo",
      "Memmo Alfama",
    ]);
    const read = calls.find((c) => c.url.startsWith("/api/state/hotel?"))?.url ?? "";
    expect(read).toContain("orderBy=price");
    expect(decodeURIComponent(read)).toContain('where={"shortlisted":true}');
    // Read-only: a page has no component on the server to tick.
    expect(list.querySelector("input")).toBeNull();

    // And kept current like a list sent in chat.
    hotels = [...hotels.slice(0, 2), rec("hotel", "santiago", { name: "Santiago de Alfama", price: 165 })];
    await act(async () =>
      FakeEventSource.last?.emit("change", { type: "hotel", id: "santiago", op: "create", version: 1, after: {} }),
    );
    await act(async () => {});
    expect([...list.querySelectorAll(".iface-list li")].map((l) => l.textContent)).toContain("Santiago de Alfama");
  });

  it("says an added section is loading, or couldn't be read, rather than that nothing matches", async () => {
    let release = () => {};
    hotelsRead = new Promise<void>((r) => {
      release = r;
    });
    agent = withShortlist();
    await render();
    const list = () => section("Hotel shortlist") as HTMLElement;
    expect(list().textContent).toBe("Hotel shortlistLoading…");
    await act(async () => release());
    await act(async () => {});
    expect([...list().querySelectorAll(".iface-list li")].map((l) => l.textContent)).toEqual([
      "Lisboa Tejo",
      "Memmo Alfama",
    ]);

    act(() => root.unmount());
    root = createRoot(container);
    hotelsRead = "fail";
    await render();
    await act(async () => {});
    expect(list().textContent).toBe("Hotel shortlistCouldn't read these records.");
    expect(list().textContent).not.toContain("Nothing matches");
  });

  it("says a fresh agent has nothing yet in one line, so the form isn't pushed under empty sections", async () => {
    agent = { ...tripPlanner(), commitments: [], docs: [], misses: [] };
    await render();
    expect(headings()).toEqual(["What I'm for", "Hand it something"]);
    expect(section("Nothing yet")?.textContent).toBe(
      "Nothing open, waiting on you, finished lately or written up yet. Hand it something below.",
    );

    // It says only the sections the page shows, where the first of them goes.
    act(() => root.unmount());
    root = createRoot(container);
    agent = {
      ...tripPlanner(),
      commitments: [],
      docs: [],
      misses: [],
      page: rec("page", "trip-planner", { owner: "trip-planner", order: ["waiting", "about"], hide: ["docs"] }),
    };
    await render();
    expect(container.querySelector(".agent-page")?.firstElementChild?.getAttribute("aria-label")).toBe("Nothing yet");
    expect(section("Nothing yet")?.textContent).toBe(
      "Nothing waiting on you, open or finished lately yet. Hand it something below.",
    );

    // Any work at all brings the sections back.
    act(() => root.unmount());
    root = createRoot(container);
    agent = { ...tripPlanner(), commitments: [], misses: [] };
    await render();
    expect(section("Nothing yet")).toBeNull();
    expect(section("Working on")?.textContent).toContain("Nothing open right now.");
  });

  it("keeps ages current on a page left open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: NOW });
    try {
      await render();
      const meta = () => readText(section("Working on")?.querySelector(".agent-page-meta"));
      expect(meta()).toBe("check Friday · asks first · updated 2h ago");
      await act(async () => vi.advanceTimersByTime(60 * 60_000));
      expect(meta()).toBe("check Friday · asks first · updated 3h ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says it couldn't load when the directory fails with something that isn't JSON, not that it's off", async () => {
    directoryBroken = true;
    await render();
    expect(container.textContent).toContain("Couldn't load the page: 500");
    expect(container.textContent).not.toContain("Turn on the directory");
  });

  it("keeps up with the agent's records as they change, and ignores other agents'", async () => {
    await render();
    const before = calls.filter((c) => c.url === "/api/ext/builtin:directory/agents/trip-planner").length;
    const next = tripPlanner();
    next.commitments[0].data.progress = { value: 4, max: 5 };
    agent = next;

    await act(async () =>
      FakeEventSource.last?.emit("change", {
        type: "commitment",
        id: "planner-weekly",
        op: "update",
        before: { owner: "planner" },
        after: { owner: "planner" },
      }),
    );
    await settle();
    expect(calls.filter((c) => c.url === "/api/ext/builtin:directory/agents/trip-planner").length).toBe(before);

    await act(async () =>
      FakeEventSource.last?.emit("change", {
        type: "commitment",
        id: "trip-planner-lisbon",
        op: "update",
        before: { owner: "trip-planner" },
        after: { owner: "trip-planner" },
      }),
    );
    await settle();
    expect(calls.filter((c) => c.url === "/api/ext/builtin:directory/agents/trip-planner").length).toBe(before + 1);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("80");
  });

  it("shows the configured description and how to turn the directory on, when it's off", async () => {
    for (const off of ["404", "html"] as const) {
      directoryOff = off;
      await render("trip-planner", "Plans trips, books hotels.");
      expect(container.textContent).toContain("Plans trips, books hotels.");
      expect(container.textContent).toContain("Turn on the directory");
      expect(container.querySelector("form")).toBeNull();
      act(() => root.unmount());
      root = createRoot(container);
    }
  });
});

describe("handing it something", () => {
  const field = (i: number) => container.querySelectorAll(".agent-page-form input")[i] as HTMLInputElement;
  const submit = () => container.querySelector(".agent-page-form button") as HTMLButtonElement;

  /** Type the way a person does, through React's own change handling. */
  function type(input: HTMLInputElement, value: string) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("opens a commitment for the agent from the goal and done-when, says so, and clears the form", async () => {
    await render();
    expect(submit().disabled).toBe(true);
    await act(async () => {
      type(field(0), "  Book a fado night ");
      type(field(1), "A table for two");
    });
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    await act(async () => {});
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      url: "/api/ext/builtin:directory/agents/trip-planner/commitments",
      body: { goal: "Book a fado night", doneWhen: "A table for two" },
    });
    expect(container.querySelector("output")?.textContent).toBe(
      "Handed to trip-planner: “Book a fado night”. It sees this under “Your commitments” on its next turn.",
    );
    expect(field(0).value).toBe("");
    expect(field(1).value).toBe("");
  });

  it("hints with a kind of work the agent takes on, or asks plainly without a profile", async () => {
    await render();
    expect(field(0).placeholder).toBe("Something like: trip research");
    act(() => root.unmount());
    root = createRoot(container);
    agent = { ...tripPlanner(), profile: null as never };
    await render();
    expect(field(0).placeholder).toBe("What should it take on?");
  });

  it("says why the agent won't see it in its prompt: no commitment tool, or the block turned off", async () => {
    const said: Record<string, string> = {
      tool: "It doesn't have the commitment tool, so it won't see this in its prompt.",
      pin: "The “Your commitments” block is turned off, so it won't see this unless it looks.",
    };
    for (const why of ["tool", "pin"]) {
      handWhy = why;
      await render();
      await act(async () => type(field(0), "Book a fado night"));
      await act(async () => submit().click());
      await act(async () => {});
      expect(container.querySelector("output")?.textContent).toBe(
        `Handed to trip-planner: “Book a fado night”. ${said[why]}`,
      );
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it("lets a person give it more autonomy than it can give itself", async () => {
    await render();
    const choice = container.querySelector(".agent-page-form select") as HTMLSelectElement;
    expect(choice.value).toBe("suggest");
    expect([...choice.options].map((o) => o.textContent)).toEqual([
      "asks first",
      "acts, then tells you",
      "acts quietly",
    ]);
    await act(async () => {
      type(field(0), "Rebook the flights if they move");
      choice.value = "tell";
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => submit().click());
    await act(async () => {});
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      goal: "Rebook the flights if they move",
      autonomy: "tell",
    });
  });

  it("leaves done-when out when it's empty, and shows the server's refusal", async () => {
    handStatus = 400;
    await render();
    await act(async () => type(field(0), "Something"));
    await act(async () => submit().click());
    await act(async () => {});
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ goal: "Something" });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Say what you're handing over.");
    expect(field(0).value).toBe("Something");
  });
});

describe("autonomy on its work", () => {
  const pick = () => section("Working on")?.querySelector(".agent-page-meta select") as HTMLSelectElement;
  const choose = (value: string) =>
    act(async () => {
      const select = pick();
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  const reads = () => calls.filter((c) => c.url === "/api/ext/builtin:directory/agents/trip-planner").length;

  it("lets a person change what a commitment may do on its own, in place, and shows it at once", async () => {
    await render();
    expect(pick().value).toBe("suggest");
    const before = reads();
    await choose("quiet");
    // The pick holds while the record is saved, rather than springing back until the stream redraws.
    expect(pick().value).toBe("quiet");
    await act(async () => {});
    expect(calls.find((c) => c.method === "PATCH")).toEqual({
      method: "PATCH",
      url: "/api/state/commitment/trip-planner-lisbon",
      body: { changes: { autonomy: "quiet" }, expectedVersion: 1 },
    });
    // Saved, the page reads itself again, without waiting on the stream.
    expect(reads()).toBe(before + 1);
    expect(pick().value).toBe("quiet");
  });

  it("says a refusal under the line, in plain words when the record changed meanwhile", async () => {
    patchAnswer = {
      status: 409,
      body: { error: "commitment/trip-planner-lisbon is at version 4, but the write expected version 1." },
    };
    await render();
    await choose("tell");
    await act(async () => {});
    const item = section("Working on")?.querySelector(".agent-page-item") as HTMLElement;
    const alert = item.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("This changed while you were looking. Pick again.");
    // A line of its own, not squeezed into the unbreakable facts.
    expect(alert?.closest(".agent-page-meta")).toBeNull();
    expect(pick().value).toBe("suggest");

    patchAnswer = { status: 400, body: { error: "autonomy is one of: suggest, tell, quiet." } };
    await choose("quiet");
    await act(async () => {});
    expect(item.querySelector('[role="alert"]')?.textContent).toBe("autonomy is one of: suggest, tell, quiet.");
  });
});

describe("upkeep", () => {
  const upkeepLine = () => section("Upkeep");
  const tidyButton = () => upkeepLine()?.querySelector("button") as HTMLButtonElement;
  const status = () => upkeepLine()?.querySelector("output")?.textContent;
  const changed = { archived: 2, reviewed: 1, updated: 0, closed: 1 };

  it("says when it last looked after what it owns and what that changed, over the page", async () => {
    agent = { ...tripPlanner(), upkeep: { running: false, at: hoursAgo(3), changed, every: "day" } } as never;
    await render();
    expect(container.querySelector(".agent-page")?.firstElementChild?.getAttribute("aria-label")).toBe("Upkeep");
    expect(status()).toBe("Last upkeep 3h ago: archived 2, reviewed 1, closed 1.Comes round every day.");
    expect(tidyButton().textContent).toBe("Tidy up now");
    expect(tidyButton().disabled).toBe(false);
  });

  it("says when it has had none, when one changed nothing, and when one stopped", async () => {
    for (const [upkeep, said] of [
      [{ running: false }, "No upkeep yet."],
      [
        { running: false, at: hoursAgo(1), changed: { archived: 0, reviewed: 0, updated: 0, closed: 0 } },
        "Last upkeep 1h ago: changed nothing.",
      ],
      [{ running: false, at: hoursAgo(1) }, "Last upkeep 1h ago."],
      [
        { running: false, error: "the model is unreachable", failedAt: hoursAgo(2) },
        "Couldn't tidy up 2h ago: the model is unreachable",
      ],
      // The last good one stays in view after a failure, so the failure reads as newer than it.
      [
        { running: false, at: hoursAgo(26), changed, error: "fetch failed", failedAt: hoursAgo(1) },
        "Couldn't tidy up 1h ago: fetch failedLast upkeep 1d ago: archived 2, reviewed 1, closed 1.",
      ],
    ] as const) {
      agent = { ...tripPlanner(), upkeep } as never;
      await render();
      expect(status()).toBe(said);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it("isn't there for an agent with no upkeep to do", async () => {
    agent = { ...tripPlanner(), upkeep: null } as never;
    await render();
    expect(upkeepLine()).toBeNull();
  });

  it("tidies up now when asked, says so while it runs, and says what changed when it finishes", async () => {
    agent = { ...tripPlanner(), upkeep: { running: false, at: hoursAgo(30), changed } } as never;
    await render();
    // The server has it running by the time the page reads it again.
    agent = { ...tripPlanner(), upkeep: { running: true, at: hoursAgo(30), changed } } as never;
    await act(async () => tidyButton().click());
    await act(async () => {});
    expect(calls.find((c) => c.method === "POST")).toEqual({
      method: "POST",
      url: "/api/ext/builtin:directory/agents/trip-planner/upkeep",
    });
    expect(status()).toBe("Tidying up: going over its commitments, docs, page and notes…");
    expect(tidyButton().textContent).toBe("Tidying up…");
    expect(tidyButton().disabled).toBe(true);

    // It finishes: the upkeep record changes, and the page hears of it.
    agent = {
      ...tripPlanner(),
      upkeep: {
        running: false,
        at: new Date().toISOString(),
        changed: { archived: 1, reviewed: 1, updated: 0, closed: 0 },
      },
    } as never;
    await act(async () =>
      FakeEventSource.last?.emit("change", {
        type: "upkeep",
        id: "trip-planner",
        op: "update",
        before: { owner: "trip-planner" },
        after: { owner: "trip-planner" },
      }),
    );
    await settle();
    expect(status()).toBe("✓ Tidied up just now: archived 1, reviewed 1.");
    expect(tidyButton().disabled).toBe(false);
  });

  it("reads itself again while a turn runs, so the end shows even without the stream", async () => {
    agent = { ...tripPlanner(), upkeep: { running: true } } as never;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await render();
      const reads = () => calls.filter((c) => c.url === "/api/ext/builtin:directory/agents/trip-planner").length;
      const before = reads();
      agent = { ...tripPlanner(), upkeep: { running: false, at: new Date().toISOString(), changed } } as never;
      await act(async () => vi.advanceTimersByTime(2_000));
      await act(async () => {});
      expect(reads()).toBe(before + 1);
      expect(status()).toBe("✓ Tidied up just now: archived 2, reviewed 1, closed 1.");
      // Finished, it stops asking.
      await act(async () => vi.advanceTimersByTime(10_000));
      expect(reads()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the server's reason when it can't tidy up now", async () => {
    upkeepAnswer = { status: 409, body: { error: "trip-planner can't tidy up now: agents are paused." } };
    agent = { ...tripPlanner(), upkeep: { running: false } } as never;
    await render();
    await act(async () => tidyButton().click());
    await act(async () => {});
    expect(upkeepLine()?.querySelector('[role="alert"]')?.textContent).toBe(
      "trip-planner can't tidy up now: agents are paused.",
    );
    expect(tidyButton().disabled).toBe(false);

    // The pause lifts and a scheduled upkeep runs and finishes: the old refusal goes, not to contradict it.
    agent = { ...tripPlanner(), upkeep: { running: false, at: new Date().toISOString(), changed } } as never;
    await act(async () =>
      FakeEventSource.last?.emit("change", {
        type: "upkeep",
        id: "trip-planner",
        op: "update",
        before: { owner: "trip-planner" },
        after: { owner: "trip-planner" },
      }),
    );
    await settle();
    expect(status()).toBe("Last upkeep just now: archived 2, reviewed 1, closed 1.");
    expect(upkeepLine()?.querySelector('[role="alert"]')).toBeNull();
  });
});
