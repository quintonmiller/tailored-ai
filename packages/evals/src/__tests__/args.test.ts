/**
 * Every documented invocation of this CLI is a `pnpm run` line, and pnpm
 * forwards the `--` separator to the script. Until this was handled, all of
 * them failed: `run` silently discarded every flag and then complained that no
 * model was given, and `compare` tried to open a report called `--`.
 *
 * The control cases matter as much as the fix. A `stripSeparator` that just
 * filtered out every `--` would pass a one-directional test and quietly break
 * the one case where the separator means what it says.
 */

import { describe, expect, it } from "vitest";
import { stripSeparator } from "../args.js";

describe("stripSeparator", () => {
  it("drops the separator pnpm forwards, so the flags after it are parsed", () => {
    // `pnpm run eval -- --home ~/.tailored-ai` reaches the script like this.
    expect(stripSeparator(["run", "--", "--home", "/home/test/.tailored-ai"])).toEqual([
      "run",
      "--home",
      "/home/test/.tailored-ai",
    ]);
  });

  it("drops it ahead of the subcommand too", () => {
    // `pnpm exec tsx src/cli.ts -- run --model x` puts it first instead.
    expect(stripSeparator(["--", "run", "--model", "qwen"])).toEqual(["run", "--model", "qwen"]);
  });

  it("recovers the report paths `compare` reads positionally", () => {
    expect(stripSeparator(["compare", "--", "before.json", "after.json"])).toEqual([
      "compare",
      "before.json",
      "after.json",
    ]);
  });

  it("keeps a second separator, which is a real end-of-options marker", () => {
    expect(stripSeparator(["run", "--", "--filter", "budget", "--", "--not-a-flag"])).toEqual([
      "run",
      "--filter",
      "budget",
      "--",
      "--not-a-flag",
    ]);
  });

  it("leaves args that never had one untouched", () => {
    const argv = ["run", "--home", "/home/test/.tailored-ai", "--repeats", "3"];
    expect(stripSeparator(argv)).toEqual(argv);
  });

  it("leaves an empty invocation alone", () => {
    expect(stripSeparator([])).toEqual([]);
  });
});
