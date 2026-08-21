/**
 * The terminal rung.
 *
 * A terminal is the bottom of the surface ladder, so this is where the "never
 * silence" rule is easiest to break and least likely to be noticed — nobody
 * files a bug saying a line they never saw did not appear.
 */

import type { MediaRef, MediaStore } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import { describeMedia, TERMINAL_SURFACE } from "../media-render.js";

const REF: MediaRef = {
  id: "f".repeat(64),
  mimeType: "image/png",
  bytes: 2048,
  name: "chart.png",
  width: 800,
  height: 600,
};

function store(over: Partial<MediaStore> = {}): MediaStore {
  return {
    id: "fake",
    put: async () => REF,
    get: async () => undefined,
    stat: async () => undefined,
    delete: async () => false,
    ...over,
  } as MediaStore;
}

describe("TERMINAL_SURFACE", () => {
  it("claims no ability to show bytes", () => {
    // If this ever flips to true, the CLI starts silently swallowing images:
    // the ladder would route them to an attachment nobody uploads.
    expect(TERMINAL_SURFACE.attachments).toBe(false);
    expect(TERMINAL_SURFACE.inlineMedia).toBe(false);
    expect(TERMINAL_SURFACE.links).toBe(true);
  });
});

describe("describeMedia", () => {
  it("says nothing when there is nothing", () => {
    expect(describeMedia([])).toEqual([]);
  });

  it("prints a placeholder plus a file:// path when the store is local", () => {
    const s = store({ localPathFor: () => "/home/test/.tai/media/ff/chart.png" });
    const [line] = describeMedia([REF], s);
    expect(line).toContain("chart.png");
    expect(line).toContain("file:///home/test/.tai/media/ff/chart.png");
  });

  it("falls back to an http url when the store has no local path", () => {
    const s = store({ urlFor: () => "https://tai.test/api/media/abc" });
    expect(describeMedia([REF], s)[0]).toContain("https://tai.test/api/media/abc");
  });

  it("prefers the local path over the url — a terminal user can open a file", () => {
    const s = store({
      localPathFor: () => "/var/media/chart.png",
      urlFor: () => "https://tai.test/api/media/abc",
    });
    const [line] = describeMedia([REF], s);
    expect(line).toContain("file:///var/media/chart.png");
    expect(line).not.toContain("https://tai.test");
  });

  it("still describes the item with no store at all", () => {
    const [line] = describeMedia([REF]);
    expect(line).toContain("chart.png");
  });

  it("prints one line per item", () => {
    const second: MediaRef = { ...REF, id: "e".repeat(64), name: "second.png" };
    const lines = describeMedia([REF, second], store({ localPathFor: (r) => `/m/${r.name}` }));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("second.png");
  });
});
