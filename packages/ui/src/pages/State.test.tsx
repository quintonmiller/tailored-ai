/**
 * The State page: browsing, live updates from the stream, a save that
 * refuses to overwrite a change made while the person was editing, and
 * archiving: hidden until asked for, marked with when and why, restorable.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { State } from "./State";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no EventSource; this one lets a test push events. */
class FakeEventSource {
  static last: FakeEventSource | undefined;
  listeners = new Map<string, ((ev: { data: string }) => void)[]>();
  onerror: (() => void) | null = null;
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

const plan = {
  name: "plan",
  description: "A plan someone is working through.",
  title: "name",
  canWrite: true,
};
const record = (id: string, name: string, version = 1) => ({
  type: "plan",
  id,
  scope: "global",
  data: { name },
  version,
  createdAt: "2026-10-18T09:00:00.000Z",
  updatedAt: new Date().toISOString(),
  updatedBy: { kind: "agent", name: "planner" },
});

let root: Root;
let container: HTMLDivElement;
let types: unknown[];
let records: Record<string, unknown>[];
let history: unknown[];
let putStatus: number;
let putBody: unknown;
const calls: { method: string; url: string; body?: unknown }[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  types = [plan];
  records = [record("trip", "Lisbon trip"), record("move", "Move house")];
  history = [
    {
      type: "plan",
      id: "trip",
      scope: "global",
      op: "create",
      after: { name: "Lisbon trip" },
      version: 1,
      actor: { kind: "agent", name: "planner" },
      at: "2026-10-18T09:00:00.000Z",
    },
  ];
  putStatus = 200;
  putBody = record("trip", "Lisbon trip, May", 2);
  calls.length = 0;
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (method === "PUT") return new Response(JSON.stringify(putBody), { status: putStatus });
      const archiving = url.match(/^\/api\/state\/plan\/([^/]+)\/(archive|unarchive)$/);
      if (method === "POST" && archiving) {
        const reason = (JSON.parse(String(init?.body ?? "{}")) as { reason?: string }).reason;
        records = records.map((r) => {
          if (r.id !== archiving[1]) return r;
          const { archivedAt: _a, archivedBy: _b, archiveReason: _c, ...rest } = r;
          return archiving[2] === "archive"
            ? {
                ...rest,
                archivedAt: new Date().toISOString(),
                archivedBy: { kind: "user", name: "owner" },
                archiveReason: reason,
              }
            : rest;
        });
        return new Response(JSON.stringify(records.find((r) => r.id === archiving[1])));
      }
      if (url === "/api/state/types") return new Response(JSON.stringify({ types }));
      if (url.includes("/history")) return new Response(JSON.stringify({ changes: history }));
      const one = url.match(/^\/api\/state\/plan\/([^/?]+)$/);
      if (one) {
        const found = records.find((r) => r.id === one[1]);
        return found ? new Response(JSON.stringify(found)) : new Response("{}", { status: 404 });
      }
      // Archived records only when asked for, as the server lists them.
      const shown = url.includes("includeArchived=1") ? records : records.filter((r) => !r.archivedAt);
      return new Response(JSON.stringify({ records: shown }));
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(props: { type?: string; id?: string } = {}) {
  await act(async () => {
    root.render(<State {...props} />);
  });
  // Let the chained fetches (types, then records, then history) settle.
  for (let i = 0; i < 3; i++) await act(async () => {});
}

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
const rows = () => [...container.querySelectorAll(".state-table tbody tr")];

describe("State page", () => {
  it("lists the types, the first type's records, and an opened record with its history", async () => {
    await render({ type: "plan", id: "trip" });
    expect(container.querySelector(".state-type.active")?.textContent).toContain("plan");
    expect(rows().map((r) => r.querySelector("td")?.textContent)).toEqual(["trip", "move"]);
    expect(container.querySelector(".state-json")?.textContent).toContain('"name": "Lisbon trip"');
    expect(container.querySelector(".state-history")?.textContent).toContain("create");
  });

  it("says what to do when there are no types", async () => {
    types = [];
    await render();
    expect(container.textContent).toContain("No state types yet");
  });

  it("refetches and highlights a record when the stream says it changed", async () => {
    await render({ type: "plan" });
    await act(async () => FakeEventSource.last?.emit("ready", {}));
    expect(container.querySelector(".state-live")?.textContent).toBe("Live");

    records = [record("trip", "Lisbon trip, May", 2), record("move", "Move house")];
    const before = calls.filter((c) => c.url.startsWith("/api/state/plan?")).length;
    await act(async () => FakeEventSource.last?.emit("change", { type: "plan", id: "trip", op: "update", version: 2 }));
    await act(async () => {});

    expect(calls.filter((c) => c.url.startsWith("/api/state/plan?")).length).toBe(before + 1);
    expect(rows()[0].className).toContain("fresh");
    expect(rows()[0].textContent).toContain("Lisbon trip, May");
  });

  it("saves with the version that was opened, and shows the server's reason when it is refused", async () => {
    await render({ type: "plan", id: "trip" });
    await act(async () => button("Edit").click());
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({ name: "Lisbon trip" });

    putStatus = 409;
    putBody = { error: "plan/trip is at version 2, but the write expected version 1." };
    await act(async () => button("Save").click());

    expect(calls.find((c) => c.method === "PUT")).toEqual({
      method: "PUT",
      url: "/api/state/plan/trip",
      body: { data: { name: "Lisbon trip" }, expectedVersion: 1 },
    });
    expect(container.querySelector(".config-error")?.textContent).toBe(
      "plan/trip is at version 2, but the write expected version 1.",
    );
  });

  it("hides archived records until asked, then marks each with when and why", async () => {
    records = [
      record("trip", "Lisbon trip"),
      {
        ...record("move", "Move house", 2),
        archivedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        archivedBy: { kind: "user", name: "owner" },
        archiveReason: "moved already",
      },
    ];
    await render({ type: "plan" });
    expect(rows().map((r) => r.querySelector("td")?.textContent)).toEqual(["trip"]);
    expect(calls.some((c) => c.url.includes("includeArchived"))).toBe(false);

    const toggle = [...container.querySelectorAll("label")].find((l) => l.textContent === "Show archived");
    await act(async () => toggle?.querySelector("input")?.click());
    await act(async () => {});
    expect(calls.at(-1)?.url).toContain("includeArchived=1");
    expect(rows()).toHaveLength(2);
    const archived = rows()[1];
    expect(archived.className).toContain("archived");
    expect(archived.querySelector(".state-chip-archived")?.textContent).toBe("archived");
    expect(archived.textContent).toContain("archived 2h ago by you: moved already");
    expect(container.querySelector(".state-meta-line")?.textContent).toContain("2 records, 1 archived");
  });

  it("archives an opened record with a reason, keeps it open as archived, and restores it", async () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "  trip is over "),
    );
    await render({ type: "plan", id: "trip" });
    expect(button("Edit")).toBeDefined();
    await act(async () => button("Archive").click());
    for (let i = 0; i < 3; i++) await act(async () => {});

    expect(calls.find((c) => c.url.endsWith("/archive"))).toEqual({
      method: "POST",
      url: "/api/state/plan/trip/archive",
      body: { reason: "trip is over", expectedVersion: 1 },
    });
    // Off the list, but still open, read by id, saying so and offering a way back.
    expect(rows().map((r) => r.querySelector("td")?.textContent)).toEqual(["move"]);
    expect(container.querySelector(".state-archived-note")?.textContent).toContain(
      "Archived just now by you: trip is over",
    );
    expect(button("Edit")).toBeUndefined();
    expect(button("Archive")).toBeUndefined();

    await act(async () => button("Restore").click());
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(calls.find((c) => c.url.endsWith("/unarchive"))).toMatchObject({
      method: "POST",
      body: { expectedVersion: 1 },
    });
    expect(rows().map((r) => r.querySelector("td")?.textContent)).toEqual(["trip", "move"]);
    expect(container.querySelector(".state-archived-note")).toBeNull();
  });

  it("archives nothing when the person cancels", async () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => null),
    );
    await render({ type: "plan", id: "trip" });
    await act(async () => button("Archive").click());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("names archives and restores in a record's history, with the reason", async () => {
    history = [
      {
        type: "plan",
        id: "trip",
        scope: "global",
        op: "update",
        before: { name: "Lisbon trip" },
        after: { name: "Lisbon trip" },
        version: 2,
        actor: { kind: "user", name: "owner" },
        at: "2026-10-18T10:00:00.000Z",
        lifecycle: "archived",
        archiveReason: "trip is over",
      },
      ...history,
    ];
    await render({ type: "plan", id: "trip" });
    const first = container.querySelector(".state-history li");
    expect(first?.querySelector(".state-op")?.textContent).toBe("archived");
    expect(first?.querySelector(".state-op")?.className).toContain("state-op-archived");
    expect(first?.textContent).toContain("trip is over");
  });

  it("says a record opened by id is gone only when reading it by id says so", async () => {
    await render({ type: "plan", id: "nowhere" });
    expect(container.textContent).toContain("plan/nowhere no longer exists.");
  });

  it("warns while editing as soon as someone else changes the record", async () => {
    await render({ type: "plan", id: "trip" });
    await act(async () => button("Edit").click());
    expect(container.querySelector(".state-warning")).toBeNull();

    await act(async () => FakeEventSource.last?.emit("change", { type: "plan", id: "trip", op: "update", version: 2 }));
    expect(container.querySelector(".state-warning")?.textContent).toContain(
      "Someone changed this record while you were editing.",
    );
  });
});
