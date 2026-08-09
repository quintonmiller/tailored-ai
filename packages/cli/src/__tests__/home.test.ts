/**
 * `-c <config>` and `TAI_HOME` have to mean the same thing.
 *
 * `resolveHomeDir` has always *read* `TAI_HOME`, but nothing in the repo ever
 * wrote it — there was not one assignment. Core is a library and never sees
 * the CLI's flags, so every module that isolates per-instance state by reading
 * that variable (the vault key, the workflow secrets key, exec and tool-output
 * scratch, the sandbox scratch allowlist) was blind to `-c`. Pointing tai at a
 * second home gave it a separate config and database while its keys and cached
 * output went to the default one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptHomeDir, resolveHomeDir } from "../home.js";

const ORIGINAL = process.env.TAI_HOME;

beforeEach(() => {
  delete process.env.TAI_HOME;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TAI_HOME;
  else process.env.TAI_HOME = ORIGINAL;
});

describe("adoptHomeDir", () => {
  it("publishes the home it resolved, so core can see it", () => {
    const home = adoptHomeDir("/srv/tai-work/config.yaml");

    expect(home).toBe("/srv/tai-work");
    expect(process.env.TAI_HOME).toBe("/srv/tai-work");
  });

  it("publishes the default home too — an unset variable is what core mistook for 'no instance'", () => {
    const home = adoptHomeDir();

    expect(process.env.TAI_HOME).toBe(home);
    expect(home.endsWith("/.tailored-ai")).toBe(true);
  });

  it("lets -c win over an inherited TAI_HOME, matching resolveHomeDir's documented order", () => {
    process.env.TAI_HOME = "/srv/tai-b";

    expect(adoptHomeDir("/srv/tai-work/config.yaml")).toBe("/srv/tai-work");
    expect(process.env.TAI_HOME).toBe("/srv/tai-work");
  });

  it("agrees with resolveHomeDir, which stays free of the side effect", () => {
    const pure = resolveHomeDir("/srv/tai-work/config.yaml");

    expect(process.env.TAI_HOME).toBeUndefined();
    expect(adoptHomeDir("/srv/tai-work/config.yaml")).toBe(pure);
  });
});
