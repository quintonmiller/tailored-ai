/**
 * Answering a component, and the store behind it.
 *
 * A component takes one answer. A second click, an answer after the agent
 * closed it, or one after it expired is refused with a sentence the person can
 * read. A `reply` answer becomes the person's next message in plain words; an
 * `event` answer is announced for subscriptions and hooks.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { type RuntimeEventPayload, TypedEventBus } from "../events.js";
import { buildComponent, InterfaceError } from "../interfaces/kinds.js";
import { respondToComponent } from "../interfaces/respond.js";
import { InterfaceStore } from "../interfaces/store.js";

let clock = new Date("2026-01-05T09:00:00.000Z");
let store: InterfaceStore;
let events: TypedEventBus;
let announced: RuntimeEventPayload<"interface.action">[];

function send(kind: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const spec = buildComponent({ kind, props, ...extra }, clock);
  store.create(spec, "planner", "s1");
  return spec;
}

beforeEach(() => {
  clock = new Date("2026-01-05T09:00:00.000Z");
  store = new InterfaceStore(new Database(":memory:"), () => clock);
  events = new TypedEventBus();
  announced = [];
  events.on("interface.action", (p) => {
    announced.push(p);
  });
});

const answer = (id: string, actionId: string, value?: unknown) =>
  respondToComponent(store, events, { id, actionId, ...(value !== undefined ? { value } : {}), by: "owner" });

describe("respondToComponent", () => {
  it("turns a choice into the option's words, and records it once", () => {
    const c = send("choice", { question: "Which day?", options: ["Monday", "Tuesday"] });
    expect(answer(c.id, "option-2")).toEqual({ effect: "reply", reply: "Tuesday" });
    expect(store.get(c.id)?.status).toBe("answered");
    expect(store.get(c.id)?.response).toMatchObject({ actionId: "option-2", by: "owner" });
    expect(() => answer(c.id, "option-1")).toThrow("This has already been answered.");
  });

  it("passes a free-text answer through, and asks for text when there is none", () => {
    const c = send("choice", { question: "Where?", options: ["Home", "Office"], allowText: true });
    expect(() => answer(c.id, "text", "  ")).toThrow("Say something in the text box first.");
    expect(answer(c.id, "text", "The café on Main St")).toEqual({ effect: "reply", reply: "The café on Main St" });
  });

  it("writes a form's answers as labelled lines, and names missing required fields", () => {
    const f = send("form", {
      title: "Booking",
      fields: [
        { name: "guests", label: "Guests", type: "number", required: true },
        { name: "notes", label: "Notes" },
      ],
    });
    expect(() => answer(f.id, "submit", { notes: "late arrival" })).toThrow("Fill in: Guests.");
    expect(answer(f.id, "submit", { guests: 2, notes: "late arrival" })).toEqual({
      effect: "reply",
      reply: "Booking\nGuests: 2\nNotes: late arrival",
    });
  });

  it("announces an event action instead of replying", () => {
    const card = send(
      "card",
      { title: "Disk 95% full" },
      { actions: [{ label: "Page me", effect: "event", name: "escalate" }] },
    );
    expect(answer(card.id, "a1")).toEqual({ effect: "event" });
    expect(announced).toEqual([
      {
        componentId: card.id,
        kind: "card",
        actionId: "a1",
        label: "Page me",
        name: "escalate",
        agent: "planner",
        sessionId: "s1",
        by: "owner",
      },
    ]);
  });

  it("refuses an answer to a closed or expired component, or with an action it does not have", () => {
    const closed = send("confirm", { summary: "Go?" });
    store.close(closed.id, "decided without you");
    expect(() => answer(closed.id, "confirm")).toThrow("This was closed by the agent.");

    const timed = send("confirm", { summary: "Go?" }, { expiresInMinutes: 10 });
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect(store.get(timed.id)?.status).toBe("expired");
    expect(() => answer(timed.id, "confirm")).toThrow("This question has expired.");

    const fresh = send("confirm", { summary: "Go?" });
    expect(() => answer(fresh.id, "maybe")).toThrow('This confirm has no action "maybe".');
    expect(() => answer("c-nope", "confirm")).toThrow(InterfaceError);
  });
});

describe("InterfaceStore", () => {
  it("updates only an open component, and keeps the note a close leaves", () => {
    const c = send("confirm", { summary: "Go?" });
    const changed = { ...c, props: { summary: "Go now?" } };
    expect(store.update(changed)).toBe(true);
    expect(store.get(c.id)?.spec.props).toEqual({ summary: "Go now?" });
    expect(store.close(c.id, "too late")).toBe(true);
    expect(store.update(c)).toBe(false);
    expect(store.close(c.id)).toBe(false);
    expect(store.get(c.id)).toMatchObject({ status: "closed", note: "too late" });
  });

  it("takes exactly one answer, even when two arrive together", () => {
    const c = send("confirm", { summary: "Go?" });
    const first = { actionId: "confirm", by: "owner", at: clock.toISOString() };
    const second = { actionId: "deny", by: "owner", at: clock.toISOString() };
    expect(store.respond(c.id, first)).toBe(true);
    expect(store.respond(c.id, second)).toBe(false);
    expect(store.get(c.id)?.response).toEqual(first);
  });

  it("lists several components by id at once", () => {
    const a = send("confirm", { summary: "A?" });
    const b = send("confirm", { summary: "B?" });
    expect(
      store
        .list([a.id, b.id, "c-missing"])
        .map((r) => r.spec.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
  });
});
