/**
 * Media surviving the trip from a tool call into history.
 *
 * Two things are being defended. First, that the text-only path is completely
 * unchanged — same capping, same marker, same scratch file — because almost
 * every tool is text-only and a regression there is a regression everywhere.
 * Second, that a picture is never what gets truncated: a part holds a reference,
 * so there is nothing in it to cut, and the budget belongs to the text.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capToolOutput, capToolResultOutput } from "../agent/tool-output.js";
import { type MediaRef, mediaPart, textPart, toolOutputText } from "../content/types.js";
import { initDatabase } from "../db/schema.js";
import { DiskMediaStore } from "../media/disk.js";

const png: MediaRef = {
  id: "9".repeat(64),
  mimeType: "image/png",
  bytes: 51_200,
  name: "dashboard.png",
  width: 1280,
  height: 800,
};

const capOpts = (limit: number, scratchDir: string) => ({
  toolName: "browser",
  limit,
  sessionId: "s1",
  scratchDir,
});

describe("capToolResultOutput", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "tai-cap-test-"));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("treats a string exactly as the old path did", async () => {
    const raw = "x".repeat(5000);
    const viaParts = await capToolResultOutput(raw, capOpts(100, scratch));
    const viaString = await capToolOutput(raw, capOpts(100, scratch));
    expect(viaParts).toBe(viaString);
  });

  it("leaves a short parts result completely untouched", async () => {
    const output = { parts: [textPart("here is the dashboard"), mediaPart(png)] };
    expect(await capToolResultOutput(output, capOpts(5000, scratch))).toBe(output);
  });

  it("keeps the image when the text has to be truncated", async () => {
    // The point of the whole exercise: the budget is spent on prose, and the
    // picture — which is a reference, not bytes — survives regardless.
    const output = { parts: [textPart("y".repeat(5000)), mediaPart(png)] };
    const capped = await capToolResultOutput(output, capOpts(200, scratch));
    expect(typeof capped).not.toBe("string");
    if (typeof capped === "string") throw new Error("unreachable");
    expect(capped.parts.filter((p) => p.type === "media")).toEqual([mediaPart(png)]);
    const text = capped.parts.find((p) => p.type === "text");
    expect(text?.type === "text" && text.text.length).toBeLessThan(5000);
  });

  it("preserves a structured payload through truncation", async () => {
    const output = { parts: [textPart("z".repeat(5000))], structured: { rows: 2 } };
    const capped = await capToolResultOutput(output, capOpts(200, scratch));
    if (typeof capped === "string") throw new Error("unreachable");
    expect(capped.structured).toEqual({ rows: 2 });
  });

  it("keeps media ahead of text when that was the original order", async () => {
    const output = { parts: [mediaPart(png), textPart("w".repeat(5000))] };
    const capped = await capToolResultOutput(output, capOpts(200, scratch));
    if (typeof capped === "string") throw new Error("unreachable");
    expect(capped.parts[0].type).toBe("media");
  });

  it("does not truncate a result that is only an image", async () => {
    const output = { parts: [mediaPart(png)] };
    expect(await capToolResultOutput(output, capOpts(10, scratch))).toBe(output);
  });
});

describe("media dedupe across repeated captures", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = initDatabase(":memory:");
    dir = mkdtempSync(join(tmpdir(), "tai-shot-test-"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives an unchanged screen the same placeholder, so the repeat detector still fires", async () => {
    // The loop compares consecutive tool results verbatim to catch a stuck
    // model. Content addressing is what keeps that working: an id that varied
    // per capture would make two identical screenshots compare unequal and
    // quietly disable the guard.
    const store = new DiskMediaStore({ db, dir });
    const shot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(16).fill(0)]);
    const first = await store.put(shot, { name: "screen.png" });
    const second = await store.put(shot, { name: "screen.png" });
    expect(toolOutputText({ parts: [mediaPart(first)] })).toBe(toolOutputText({ parts: [mediaPart(second)] }));
  });
});
