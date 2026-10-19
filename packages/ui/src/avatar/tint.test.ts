/**
 * A body in a colour of its own: turned round the colour wheel the way CSS
 * hue-rotate() turns it, which leaves greys alone.
 */
import { describe, expect, it } from "vitest";
import { hueMatrix, rotatePixels } from "./tint";

const px = (...rgb: number[]) => new Uint8ClampedArray([...rgb, 255]);

describe("hue rotation", () => {
  it("does nothing at no turn, or a whole one", () => {
    for (const deg of [0, 360]) {
      const data = px(30, 160, 90);
      rotatePixels(data, hueMatrix(deg));
      expect([...data.slice(0, 3)]).toEqual([30, 160, 90]);
    }
  });

  it("leaves greys, black and white as they are", () => {
    for (const v of [0, 90, 200, 255]) {
      const data = px(v, v, v);
      rotatePixels(data, hueMatrix(137));
      for (const c of data.slice(0, 3)) expect(Math.abs(c - v)).toBeLessThanOrEqual(1);
    }
  });

  it("turns a green robot blue a third of the way round, and keeps the alpha", () => {
    const data = new Uint8ClampedArray([20, 170, 60, 200]);
    rotatePixels(data, hueMatrix(120));
    expect(data[2]).toBeGreaterThan(data[1]);
    expect(data[2]).toBeGreaterThan(data[0]);
    expect(data[3]).toBe(200);
  });
});
