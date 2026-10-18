/**
 * Narrowing the global context an agent is given.
 *
 * Global context is injected into every turn of every agent and is not
 * truncated, so it comes straight out of the history budget. `skipGlobalContext`
 * already let an agent refuse all of it, but a directory usually mixes
 * deployment-wide plumbing an agent needs with material only one role needs.
 * Observed before this existed: a set of role-playing agents on a 44k-token
 * model spent 21% of the window on files about the deployment's unrelated
 * research, every turn, with no way to drop only those.
 *
 * The filter is tested through `loadAllContext` and not only as a pure
 * function, because the bug this prevents is a filter that works in isolation
 * and is never actually reached by the loader.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAllContext, selectGlobalFiles } from "../context.js";

const FILES = ["00-how-you-work.md", "10-rooms.md", "20-the-team.md", "nuclear_fusion_2024_2026.md", "user_profile.md"];

describe("selectGlobalFiles", () => {
  it("returns everything when there is no filter", () => {
    expect(selectGlobalFiles(FILES)).toEqual(FILES);
    expect(selectGlobalFiles(FILES, {})).toEqual(FILES);
  });

  it("excludes by glob", () => {
    expect(selectGlobalFiles(FILES, { exclude: ["nuclear_*.md", "20-*.md"] })).toEqual([
      "00-how-you-work.md",
      "10-rooms.md",
      "user_profile.md",
    ]);
  });

  it("includes as a whitelist", () => {
    expect(selectGlobalFiles(FILES, { include: ["00-*.md", "10-*.md"] })).toEqual([
      "00-how-you-work.md",
      "10-rooms.md",
    ]);
  });

  it("applies include first, then exclude", () => {
    expect(selectGlobalFiles(FILES, { include: ["*.md"], exclude: ["user_*.md"] })).not.toContain("user_profile.md");
  });

  it("treats a dot as a literal, not a wildcard", () => {
    // "a.md" must not match a file actually called "aXmd".
    expect(selectGlobalFiles(["aXmd"], { include: ["a.md"] })).toEqual([]);
  });

  it("can exclude everything without being mistaken for no filter", () => {
    expect(selectGlobalFiles(FILES, { exclude: ["*"] })).toEqual([]);
  });
});

describe("loadAllContext honours the filter", () => {
  let base: string;
  let globalDir: string;
  let agentDir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "ctx-filter-"));
    globalDir = join(base, "global");
    agentDir = join(base, "agents", "reviewer");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(globalDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    for (const f of FILES) await writeFile(join(globalDir, f), `body of ${f}`);
    await writeFile(join(agentDir, "own.md"), "agent's own material");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("loads every global file when unfiltered", async () => {
    const out = await loadAllContext(base, agentDir);
    for (const f of FILES) expect(out).toContain(f);
    expect(out).toContain("own.md");
  });

  it("drops excluded files and keeps the rest", async () => {
    const out = await loadAllContext(base, agentDir, {
      exclude: ["nuclear_*.md", "20-*.md"],
    });
    expect(out).not.toContain("nuclear_fusion_2024_2026.md");
    expect(out).not.toContain("20-the-team.md");
    expect(out).toContain("10-rooms.md");
  });

  it("never filters the agent's own directory", async () => {
    // The filter is about the shared directory. An agent's own context is
    // already scoped to it, so excluding "*" must not silence it.
    const out = await loadAllContext(base, agentDir, { exclude: ["*"] });
    expect(out).toContain("own.md");
    for (const f of FILES) expect(out).not.toContain(`## ${f}`);
  });
});
