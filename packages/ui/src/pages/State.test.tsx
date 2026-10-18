/**
 * The State page: browsing, live updates from the stream, and a save that
 * refuses to overwrite a change made while the person was editing.
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
let records: unknown[];
let putStatus: number;
let putBody: unknown;
const calls: { method: string; url: string; body?: unknown }[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  types = [plan];
  records = [record("trip", "Lisbon trip"), record("move", "Move house")];
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
      if (url === "/api/state/types") return new Response(JSON.stringify({ types }));
      if (url.includes("/history")) {
        return new Response(
          JSON.stringify({
            changes: [
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
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ records }));
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
