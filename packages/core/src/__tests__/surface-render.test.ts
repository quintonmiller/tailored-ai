/**
 * The surface degradation ladder.
 *
 * The load-bearing assertion in here is the last one: nothing a caller hands
 * this function can come out the other side as silence. Every other test is
 * about *which* rung was taken; that one is about the rule the whole design
 * rests on.
 */

import { describe, expect, it } from "vitest";
import { type SurfaceCapabilities, surfaceAccepts, TEXT_ONLY_SURFACE } from "../channels/capabilities.js";
import { attachmentName, DEFAULT_MAX_ATTACHMENTS, renderForSurface } from "../channels/render.js";
import type { MediaRef } from "../content/types.js";

function ref(over: Partial<MediaRef> = {}): MediaRef {
  return {
    id: "a".repeat(64),
    mimeType: "image/png",
    bytes: 1024,
    name: "chart.png",
    width: 800,
    height: 600,
    ...over,
  };
}

const RICH: SurfaceCapabilities = {
  inlineMedia: true,
  attachments: true,
  links: true,
  maxMessageLength: 2000,
  maxBytes: 8 * 1024 * 1024,
};

describe("surfaceAccepts", () => {
  it("refuses everything on a text-only surface", () => {
    expect(surfaceAccepts(TEXT_ONLY_SURFACE, "image/png", 10)).toBe(false);
  });

  it("refuses an item over the byte cap", () => {
    expect(surfaceAccepts(RICH, "image/png", RICH.maxBytes! + 1)).toBe(false);
    expect(surfaceAccepts(RICH, "image/png", RICH.maxBytes!)).toBe(true);
  });

  it("honours a mime allowlist, globs included", () => {
    const imagesOnly = { ...RICH, mimeTypes: ["image/*"] };
    expect(surfaceAccepts(imagesOnly, "image/webp", 10)).toBe(true);
    expect(surfaceAccepts(imagesOnly, "application/pdf", 10)).toBe(false);
  });

  it("treats an absent cap as unknown rather than unlimited-but-declared", () => {
    // No maxBytes means nothing was declared; the ladder still accepts, but
    // the contract suite is what stops a real surface shipping without one.
    const noCap: SurfaceCapabilities = { ...RICH, maxBytes: undefined };
    expect(surfaceAccepts(noCap, "image/png", 10 ** 9)).toBe(true);
  });
});

describe("renderForSurface", () => {
  it("passes a plain string through untouched", () => {
    const out = renderForSurface("just words", RICH);
    expect(out.text).toBe("just words");
    expect(out.attachments).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it("attaches media a rich surface accepts, and leaves no placeholder for it", () => {
    const out = renderForSurface(
      {
        parts: [
          { type: "text", text: "here" },
          { type: "media", media: ref() },
        ],
      },
      RICH,
    );
    expect(out.text).toBe("here");
    expect(out.attachments).toHaveLength(1);
    expect(out.warnings).toEqual([]);
  });

  it("degrades to a link when the surface takes no bytes", () => {
    const out = renderForSurface({ parts: [{ type: "media", media: ref() }] }, TEXT_ONLY_SURFACE, {
      linkFor: () => "https://example.test/media/abc",
    });
    expect(out.attachments).toEqual([]);
    expect(out.text).toContain("https://example.test/media/abc");
    expect(out.text).toContain("chart.png");
    expect(out.warnings.join(" ")).toContain("takes text only");
  });

  it("falls to a bare placeholder when there is no link to give", () => {
    const out = renderForSurface({ parts: [{ type: "media", media: ref() }] }, TEXT_ONLY_SURFACE);
    expect(out.text).toContain("chart.png");
    expect(out.text).not.toContain("http");
  });

  it("prefers the ref's own url over the resolver", () => {
    const out = renderForSurface(
      { parts: [{ type: "media", media: ref({ url: "https://cdn.test/x.png" }) }] },
      TEXT_ONLY_SURFACE,
      {
        linkFor: () => "https://local.test/should-not-win",
      },
    );
    expect(out.text).toContain("https://cdn.test/x.png");
    expect(out.text).not.toContain("should-not-win");
  });

  it("says why an oversized item was not attached", () => {
    const big = ref({ bytes: RICH.maxBytes! + 1 });
    const out = renderForSurface({ parts: [{ type: "media", media: big }] }, RICH);
    expect(out.attachments).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/over the .*-byte limit/);
  });

  it("dedupes by content hash", () => {
    // Same bytes screenshotted twice is one blob and one attachment.
    const same = ref();
    const out = renderForSurface(
      {
        parts: [
          { type: "media", media: same },
          { type: "media", media: { ...same } },
        ],
      },
      RICH,
    );
    expect(out.attachments).toHaveLength(1);
  });

  it("caps the attachment count and reports the overflow rather than trimming it", () => {
    const many = Array.from({ length: DEFAULT_MAX_ATTACHMENTS + 2 }, (_, i) =>
      ref({ id: String(i).padStart(64, "0"), name: `shot-${i}.png` }),
    );
    const out = renderForSurface({ parts: many.map((media) => ({ type: "media" as const, media })) }, RICH);
    expect(out.attachments).toHaveLength(DEFAULT_MAX_ATTACHMENTS);
    expect(out.warnings).toHaveLength(2);
    // The two that did not fit still appear in the text — that is the rule.
    expect(out.text).toContain("shot-4.png");
    expect(out.text).toContain("shot-5.png");
  });

  it("never turns media into silence, on any surface", () => {
    const surfaces: SurfaceCapabilities[] = [
      RICH,
      TEXT_ONLY_SURFACE,
      { ...RICH, maxBytes: 1 },
      { ...RICH, mimeTypes: ["text/plain"] },
      { ...RICH, attachments: false, inlineMedia: false, links: false },
    ];
    for (const caps of surfaces) {
      const out = renderForSurface({ parts: [{ type: "media", media: ref() }] }, caps);
      const delivered = out.attachments.length > 0 || out.text.length > 0;
      expect(delivered, `media vanished on ${JSON.stringify(caps)}`).toBe(true);
    }
  });
});

describe("attachmentName", () => {
  it("keeps a name that already has an extension", () => {
    expect(attachmentName(ref({ name: "report.pdf", mimeType: "application/pdf" }))).toBe("report.pdf");
  });

  it("adds one derived from the mime type when the name has none", () => {
    expect(attachmentName(ref({ name: "screenshot" }))).toBe("screenshot.png");
  });

  it("falls back to the content hash when there is no name at all", () => {
    expect(attachmentName(ref({ name: undefined }))).toBe(`${"a".repeat(12)}.png`);
  });

  it("strips path separators out of an inbound name", () => {
    // The name can come from anyone who can upload a file.
    const named = attachmentName(ref({ name: "../../etc/passwd" }));
    expect(named).not.toContain("/");
    expect(named).not.toContain("..");
  });

  it("still produces something openable for an unknown mime type", () => {
    expect(attachmentName(ref({ name: undefined, mimeType: "image/x-fictional" }))).toMatch(/\.fictional$/);
  });
});
