/**
 * The words in a speech bubble: a glimpse of what was said, wrapped into a
 * few short lines, cut short with an ellipsis when there is more. And a sign
 * over a head: put away while a cue over its group says it, or far off.
 */
import { describe, expect, it } from "vitest";
import { SignPost, wrap } from "./signs";

// jsdom draws nothing on a canvas, and says so on every try: a sign is simply left blank here.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

describe("wrap", () => {
  it("keeps a short line as it is", () => {
    expect(wrap("On it.")).toEqual(["On it."]);
  });

  it("breaks between words, never past the width", () => {
    const lines = wrap("Flights are booked for Thursday and the hotel is next on my list");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    expect(lines.join(" ")).toBe("Flights are booked for Thursday and the hotel is next on my list");
  });

  it("stops at three lines, the last ending in an ellipsis", () => {
    const lines = wrap("word ".repeat(60));
    expect(lines).toHaveLength(3);
    expect(lines[2].endsWith("…")).toBe(true);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
  });

  it("cuts a word too long for any line", () => {
    const [line] = wrap("x".repeat(80));
    expect(line.length).toBeLessThanOrEqual(30);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("a sign over a head", () => {
  const drawn = (post: SignPost) => post.group.children.filter((c) => c.visible).length;

  it("stays put away, every frame, while a cue over the group thinking with it says it, far off or near", () => {
    const post = new SignPost();
    post.set("think", 0);
    post.pool(true);
    for (const strength of [1, 0.5]) {
      post.strength = strength;
      post.update(1);
      expect(drawn(post), `strength ${strength}`).toBe(0);
      expect(post.fit(0.005, [0.2, 0.36])).toBeUndefined();
    }
    post.pool(false);
    post.update(2);
    expect(drawn(post)).toBe(1);
    post.dispose();
  });

  it("is put away far off, and back as the camera comes in", () => {
    const post = new SignPost();
    post.set("chat", 0);
    post.strength = 0;
    post.update(1);
    expect(drawn(post)).toBe(0);
    expect(post.fit(0.005, [0.2, 0.36])).toBeUndefined();
    post.strength = 1;
    post.update(2);
    expect(drawn(post)).toBe(1);
    expect(post.fit(0.005, [0.2, 0.36])).toBeGreaterThan(0);
    post.dispose();
  });
});
