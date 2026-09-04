import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `resolveAgent`'s options argument is the seventh positional parameter, and
 * every part of it is optional — so a call site that forgets it compiles, runs,
 * and silently gives the agent an *empty skill catalog*. A progressive agent
 * then cannot discover any skill it was not told about by name.
 *
 * That is exactly what happened: five call sites across the room watcher, the
 * task watcher and the Discord channel all stopped at `contextDir`, and the
 * only warning was one line at startup that had been scrolling past for weeks.
 *
 * A type cannot catch this — the parameter is legitimately optional for tests
 * and for callers with no runtime. So the shape of the call is asserted here
 * instead, which is what a new call site will trip over.
 */
describe("every resolveAgent caller passes the resolve options", () => {
  const files = ["rooms/watcher.ts", "task-watcher.ts", "channels/discord.ts", "runtime.ts"];

  for (const rel of files) {
    it(rel, () => {
      const src = readFileSync(join(import.meta.dirname, "..", rel), "utf8");
      // Each `resolveAgent(` ... `);` block, ignoring the declaration itself.
      // Single-line calls count too — the one that was missed here was a
      // one-liner, which an indentation-anchored pattern skips right over.
      const calls = [...src.matchAll(/resolveAgent\(([\s\S]*?)\);/g)];
      expect(calls.length).toBeGreaterThan(0);
      const missing = calls.map((m) => m[1]).filter((args) => !/resolveOpt|ResolveOptions/.test(args));
      expect(
        missing,
        `a resolveAgent call in ${rel} omits the resolve options, which leaves a ` +
          `progressive agent with an empty skill catalog`,
      ).toEqual([]);
    });
  }
});
