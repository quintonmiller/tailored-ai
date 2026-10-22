/**
 * Whether the page shows what the simulation went to the trouble of sending.
 *
 * The scene contract is a promise in one direction only. The simulation is
 * checked against it, so a field that stops being *produced* fails loudly — but
 * a field that is produced and never *drawn* fails silently, and stays failed,
 * because nothing anywhere connects the two ends.
 *
 * That is not hypothetical. `cache`, `cacheTakesLeft` and `cacheOrigin` crossed
 * the contract for the entire life of the broadcast and were rendered nowhere:
 * a dead expedition offers six items and lets the party carry out two, which is
 * the scenario's flagship negotiation and the thing an eight-point milestone
 * turns on, and a viewer could not see that there was a cache at all. Route
 * `triggered` and `disarmed` went the same way, so an armed trap, a sprung one
 * and one somebody had spent a dread to make safe all drew identically.
 *
 * So this test walks the contract's own field names and asks whether each one
 * appears anywhere in the viewer. It cannot tell whether a field is drawn
 * *well* — only whether anybody thought about it — which is a low bar that four
 * fields failed for months.
 *
 * A field that genuinely should not be drawn goes in `NOT_FOR_DISPLAY` with the
 * reason. That list is the point of the test as much as the assertion is: it
 * turns "we never looked" into "we looked and decided".
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Fields the page deliberately does not draw, and why.
 *
 * Every entry is a decision. `modifiers` is the clearest of them: an affix
 * already carries a `description` reading "+8 maximum mana", generated from the
 * same numbers, so drawing the object as well would print the fact twice.
 */
const NOT_FOR_DISPLAY: Record<string, string> = {
  baseId: "the compatibility alias for old traces; the instance id is what identifies a copy",
  modifiers: "an affix's description already reads '+8 maximum mana', generated from these numbers",
  generatedName: "what the roll produced before a rename; `displayName` is what anybody is called",
  nameSource: "whether a name was rolled or chosen — provenance for the trace, not for a viewer",
  ancestry: "part of the identity prose the cast reveal renders as one line",
  archetype: "same: a label derived from the five scores, which are drawn individually",
  pronouns: "used to write the dossier prose in the simulation, not rendered as a field",
  traversals: "how often a corridor was walked; backtracking is already a metric on the scoreboard",
  log:
    "the same prose the round event carries, and the feed reads it from there — once per round " +
    "rather than once per scene, which is what stops five agents' snapshots printing one fight five times",
};

/** Every field name the contract declares. */
function contractFields(): string[] {
  const source = readFileSync(join(here, "..", "broadcast-contract.ts"), "utf8");
  return [...new Set(source.match(/^\s{2,}([a-zA-Z][a-zA-Z0-9_]*)\??:/gm) ?? [])].map((line) =>
    line.trim().replace(/\??:$/, ""),
  );
}

/**
 * Everything the browser bundle is built from, with the prose taken out.
 *
 * Comments are stripped, and that is the whole difference between this test
 * working and not working. Every one of these modules opens with a long note
 * explaining what it draws, and those notes name the fields — so a scan of the
 * raw text finds `cacheTakesLeft` in a paragraph *about* not drawing
 * `cacheTakesLeft` and calls the gap closed. Checked: with comments left in,
 * deleting the only real use of the field still passes.
 */
function viewerSource(): string {
  const dir = join(here, "..", "..", "viewer", "broadcast", "src");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

describe("the scene contract", () => {
  it("has nothing in it the page silently ignores", () => {
    const viewer = viewerSource();
    const missing = contractFields().filter(
      (field) => !NOT_FOR_DISPLAY[field] && !new RegExp(`\\b${field}\\b`).test(viewer),
    );
    expect(
      missing,
      `the simulation sends these and the broadcast reads none of them. Either draw them, or ` +
        `add them to NOT_FOR_DISPLAY in this file with the reason.`,
    ).toEqual([]);
  });

  it("does not excuse a field that is actually drawn", () => {
    // The escape hatch has to stay honest in both directions: an entry left
    // behind after somebody wired the field up would quietly re-open the gap
    // for the *next* field, because the list would no longer mean what it says.
    const viewer = viewerSource();
    const stale = Object.keys(NOT_FOR_DISPLAY).filter((field) => new RegExp(`\\b${field}\\b`).test(viewer));
    expect(stale, "these are excused from being drawn but the viewer reads them; drop them from the list").toEqual([]);
  });
});
