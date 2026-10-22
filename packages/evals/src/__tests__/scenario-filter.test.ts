/**
 * `--filter` selects the scenarios a run measures.
 *
 * The one-term behaviour is old and load-bearing (`--filter long-session` is
 * how a category is run). The comma form was added for the job that keeps
 * coming back: re-run exactly the rows a previous run failed. That set is a
 * list of ids — not a prefix, not a category — and without it the choice is 27
 * separate processes or a full run of 101 scenarios to see 27 answers.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadScenarios } from "../schema.js";

const YAML = `
- id: alpha-row
  category: addressing
  difficulty: 1
  intent: first
  message: hi
  expect:
    - replies: true
- id: beta-row
  category: restraint
  difficulty: 1
  intent: second
  message: hi
  expect:
    - replies: true
- id: gamma-row
  category: restraint
  difficulty: 1
  intent: third
  message: hi
  expect:
    - replies: true
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tai-eval-filter-"));
  writeFileSync(join(dir, "01-cases.yaml"), YAML);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ids = async (filter?: string) => (await loadScenarios(dir, filter)).scenarios.map((s) => s.id);

describe("--filter", () => {
  it("selects nothing away when absent", async () => {
    expect(await ids()).toEqual(["alpha-row", "beta-row", "gamma-row"]);
  });

  it("still matches a single id substring and a single category", async () => {
    expect(await ids("alpha")).toEqual(["alpha-row"]);
    expect(await ids("restraint")).toEqual(["beta-row", "gamma-row"]);
  });

  it("ORs comma-separated terms", async () => {
    expect(await ids("alpha-row,gamma-row")).toEqual(["alpha-row", "gamma-row"]);
  });

  it("mixes ids and categories, and tolerates spacing", async () => {
    expect(await ids("alpha-row, restraint")).toEqual(["alpha-row", "beta-row", "gamma-row"]);
  });

  it("ignores empty terms rather than selecting everything", async () => {
    // A trailing comma is what a generated filter string produces, and treating
    // the empty term as "matches all" would silently run the whole set — the
    // expensive direction of wrong.
    expect(await ids("beta-row,")).toEqual(["beta-row"]);
  });

  it("keeps the set digest over the whole file, not the selection", async () => {
    // Two runs filtered differently still have to be comparable.
    const all = await loadScenarios(dir);
    const one = await loadScenarios(dir, "alpha-row");
    expect(one.hash).toBe(all.hash);
  });
});
