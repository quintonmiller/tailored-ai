/**
 * A component part travelling through content: stored, read back, turned into
 * text for a model, and drawn as text on a surface that cannot draw it.
 *
 * The property that matters is that a component never reaches anything that
 * does not understand it. A model is sent the text form core wrote; a channel
 * posts the same text form; the database keeps the part whole so the web UI
 * can draw it later.
 */
import { describe, expect, it } from "vitest";
import { TEXT_ONLY_SURFACE } from "../channels/capabilities.js";
import { renderForSurface } from "../channels/render.js";
import { decodeMessageContent, encodeMessageContent } from "../content/codec.js";
import { type ComponentSpec, componentPart, componentSpecs, partsToText, textPart } from "../content/types.js";
import { adaptForCapabilities, resolveCapabilities } from "../providers/capabilities.js";
import type { Message } from "../providers/interface.js";

const choice: ComponentSpec = {
  id: "c-1a2b3c",
  kind: "choice",
  props: { question: "Ship it today?", options: ["yes", "no"] },
  actions: [
    { id: "option-1", label: "yes", effect: { kind: "reply" } },
    { id: "option-2", label: "no", effect: { kind: "reply" } },
  ],
  fallback: "[choice c-1a2b3c] Ship it today?\n1. yes\n2. no\nReply with a number.",
};

describe("component content", () => {
  it("reads as its fallback wherever content becomes text", () => {
    expect(partsToText([textPart("Sent choice c-1a2b3c."), componentPart(choice)])).toBe(
      `Sent choice c-1a2b3c.\n${choice.fallback}`,
    );
    expect(componentSpecs({ parts: [textPart("x"), componentPart(choice)] })).toEqual([choice]);
  });

  it("is stored whole and read back whole, not flattened to its text", () => {
    const encoded = encodeMessageContent({ parts: [textPart("Sent."), componentPart(choice)] });
    expect(decodeMessageContent(encoded)).toEqual({ parts: [textPart("Sent."), componentPart(choice)] });
  });

  it("drops a stored component that is missing what makes it drawable", () => {
    const broken = JSON.stringify({
      __tai_content: 1,
      parts: [textPart("ok"), { type: "component", component: { id: "x" } }],
    });
    expect(decodeMessageContent(broken)).toEqual({ parts: [textPart("ok")] });
  });

  it("reaches a model as text, whatever the model can take", () => {
    const messages: Message[] = [
      { role: "user", content: "Should we ship?" },
      {
        role: "tool",
        toolCallId: "t1",
        content: { parts: [textPart("Sent choice c-1a2b3c."), componentPart(choice)] },
      },
    ];
    const adapted = adaptForCapabilities(messages, resolveCapabilities());
    const parts = adapted.messages.flatMap((m) => (typeof m.content === "object" && m.content ? m.content.parts : []));
    expect(parts.some((p) => p.type === "component")).toBe(false);
    expect(parts).toContainEqual(textPart(choice.fallback));
    expect(adapted.notes).toContain("interface components shown to the model as their text form");
    // The stored history is untouched: this is a rendering for one request.
    expect(messages[1].content).toEqual({ parts: [textPart("Sent choice c-1a2b3c."), componentPart(choice)] });
  });

  it("is posted as its text form on a surface that cannot draw it", () => {
    const rendered = renderForSurface({ parts: [textPart("Here you go:"), componentPart(choice)] }, TEXT_ONLY_SURFACE);
    expect(rendered.text).toBe(`Here you go:\n\n${choice.fallback}`);
    expect(rendered.attachments).toEqual([]);
  });

  it("goes to the caller to draw on a surface that draws its kind, and as text where it does not", () => {
    const confirm: ComponentSpec = { ...choice, id: "c-4d5e6f", kind: "confirm", fallback: "[confirm c-4d5e6f] Sure?" };
    const caps = { ...TEXT_ONLY_SURFACE, components: ["choice"] };
    const rendered = renderForSurface(
      { parts: [textPart("Two things:"), componentPart(choice), componentPart(confirm)] },
      caps,
    );
    expect(rendered.components).toEqual([choice]);
    expect(rendered.text).toBe(`Two things:\n\n${confirm.fallback}`);
    expect(renderForSurface("plain", caps)).not.toHaveProperty("components");
  });
});
