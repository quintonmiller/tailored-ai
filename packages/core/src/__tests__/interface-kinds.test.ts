/**
 * The four built-in kinds: what each looks like as text, which buttons it
 * gets, and how a bad request is turned back. The text form is what a model
 * and every text-only surface see, so it is pinned word for word.
 */
import { describe, expect, it } from "vitest";
import { buildComponent, componentKindRegistry, InterfaceError, registerComponentKind } from "../interfaces/kinds.js";

const now = new Date("2026-01-05T09:00:00.000Z");

describe("buildComponent", () => {
  it("builds a choice with one button per option, and a numbered text form", () => {
    const c = buildComponent({ kind: "choice", id: "c-1", props: { question: "Which day?", options: ["Mon", "Tue"] } });
    expect(c.actions?.map((a) => [a.id, a.label, a.effect.kind])).toEqual([
      ["option-1", "Mon", "reply"],
      ["option-2", "Tue", "reply"],
    ]);
    expect(c.fallback).toBe("[choice c-1] Which day?\n1. Mon\n2. Tue\nReply with a number.");
  });

  it("adds a free-text answer to a choice that allows one", () => {
    const c = buildComponent({
      kind: "choice",
      id: "c-2",
      props: { question: "Where?", options: ["Home", "Office"], allowText: true },
    });
    expect(c.actions?.at(-1)).toEqual({ id: "text", label: "Something else", effect: { kind: "reply" } });
    expect(c.fallback.endsWith("Reply with a number, or in your own words.")).toBe(true);
  });

  it("builds a form whose text form lists what to reply with", () => {
    const c = buildComponent({
      kind: "form",
      id: "f-1",
      props: {
        title: "Booking",
        fields: [
          { name: "guests", label: "Guests", type: "number", required: true },
          { name: "room", type: "select", options: ["single", "double"] },
        ],
      },
    });
    expect(c.actions).toEqual([{ id: "submit", label: "Send", effect: { kind: "reply" } }]);
    expect(c.fallback).toBe(
      "[form f-1] Booking\nReply with:\n- Guests (number, required)\n- room (one of single, double)",
    );
  });

  it("builds a confirm with its own labels", () => {
    const c = buildComponent({
      kind: "confirm",
      id: "k-1",
      props: { summary: "Delete the draft?", confirmLabel: "Delete", denyLabel: "Keep" },
    });
    expect(c.actions?.map((a) => a.label)).toEqual(["Delete", "Keep"]);
    expect(c.fallback).toBe('[confirm k-1] Delete the draft?\nReply "Delete" or "Keep".');
  });

  it("builds a card with the buttons the agent asked for", () => {
    const c = buildComponent({
      kind: "card",
      id: "d-1",
      props: { title: "Trip", fields: [{ label: "Dates", value: "12–15 May" }] },
      actions: [{ label: "Book it" }, { label: "Page me", effect: "event", name: "escalate" }],
    });
    expect(c.actions).toEqual([
      { id: "a1", label: "Book it", effect: { kind: "reply" } },
      { id: "a2", label: "Page me", effect: { kind: "event", name: "escalate" } },
    ]);
    expect(c.fallback).toBe("[card d-1] Trip\nDates: 12–15 May\nOptions: Book it, Page me.");
  });

  it("refuses buttons on a kind whose buttons come from its props", () => {
    expect(() =>
      buildComponent({ kind: "choice", props: { question: "q", options: ["a", "b"] }, actions: [{ label: "x" }] }),
    ).toThrow("A choice's buttons come from its props; `actions` is for a card.");
  });

  it("turns a bad request back as a correction naming the field", () => {
    expect(() => buildComponent({ kind: "choice", props: { question: "Only one?", options: ["yes"] } })).toThrow(
      "The choice was not sent:\n- `options` must have at least 2 item(s)",
    );
    expect(() => buildComponent({ kind: "poll", props: {} })).toThrow(InterfaceError);
    expect(() => buildComponent({ kind: "poll", props: {} })).toThrow('There is no component kind called "poll".');
  });

  it("sets an expiry, and generates a short id when none is given", () => {
    const c = buildComponent({ kind: "confirm", props: { summary: "OK?" }, expiresInMinutes: 30 }, now);
    expect(c.expiresAt).toBe("2026-01-05T09:30:00.000Z");
    expect(c.id).toMatch(/^c-[0-9a-f]{6}$/);
  });

  it("takes a plugin's kind through the same registry", () => {
    const dispose = registerComponentKind({
      kind: "rating",
      description: "Rate something out of five.",
      schema: { type: "object", required: ["subject"], properties: { subject: { type: "string" } } },
      defaultActions: () =>
        [1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, label: String(n), effect: { kind: "reply" as const } })),
      fallback: (props) => `Rate ${String(props.subject)} from 1 to 5.`,
    });
    try {
      const c = buildComponent({ kind: "rating", id: "r-1", props: { subject: "the hotel" } });
      expect(c.fallback).toBe("[rating r-1] Rate the hotel from 1 to 5.");
      expect(c.actions).toHaveLength(5);
    } finally {
      dispose();
    }
    expect(componentKindRegistry.has("rating")).toBe(false);
  });
});
