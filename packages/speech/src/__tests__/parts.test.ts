/**
 * The drift alarm for the local content-part constructors.
 *
 * `content.ts` reimplements two of core's constructors so this package keeps
 * the zero-runtime-dependency contract core's own plugin docs describe. The
 * risk that buys is silent divergence: a part shaped almost right is accepted
 * by TypeScript here and ignored by core at render time.
 *
 * Core is a devDependency, so this test can import the real constructors and
 * compare. It is the only place in the package that touches core at runtime,
 * and it never ships.
 */
import { mediaPart as coreMediaPart, textPart as coreTextPart } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import { mediaPart, textPart } from "../content.js";

const ref = {
  id: "c".repeat(64),
  mimeType: "audio/wav",
  bytes: 1024,
  name: "dialogue.wav",
};

describe("content parts match core's", () => {
  it("textPart", () => {
    expect(textPart("hello")).toEqual(coreTextPart("hello"));
  });

  it("mediaPart", () => {
    expect(mediaPart(ref)).toEqual(coreMediaPart(ref));
  });

  it("mediaPart with alt", () => {
    expect(mediaPart(ref, "a podcast")).toEqual(coreMediaPart(ref, "a podcast"));
  });

  it("omits alt entirely rather than setting it undefined", () => {
    // `{alt: undefined}` and `{}` compare equal under toEqual but serialise
    // differently, and these parts are persisted.
    expect(Object.hasOwn(mediaPart(ref), "alt")).toBe(false);
    expect(Object.hasOwn(coreMediaPart(ref), "alt")).toBe(false);
  });
});
