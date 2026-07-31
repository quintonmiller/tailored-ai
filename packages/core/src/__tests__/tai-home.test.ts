/**
 * `TAI_HOME` is the only channel by which the CLI can tell core which
 * deployment it belongs to — core is a library and never sees `-c`.
 *
 * Before this, six modules answered "where is home?" for themselves and did
 * not agree: some read `TAI_HOME`, some `process.env.HOME`, some `homedir()`,
 * and the two scratch writers fell back to `~/.tai` rather than
 * `~/.tailored-ai`. Since nothing in the repo ever *assigned* `TAI_HOME`, the
 * readers were all taking their fallback branch — which is why a real install
 * accumulates hundreds of session directories under `~/.tai/exec-outputs`, a
 * path no config mentions.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capToolOutput } from "../agent/tool-output.js";
import { legacyScratchHome, taiHome, taiHomePath } from "../home.js";
import { ResourceLoader } from "../resources/loader.js";
import { TrustStore } from "../resources/trust.js";
import type { ToolContext } from "../tools/interface.js";
import { checkSandboxBoundary } from "../tools/sandbox-boundary.js";

const ORIGINAL = process.env.TAI_HOME;

beforeEach(() => {
  process.env.TAI_HOME = undefined;
  delete process.env.TAI_HOME;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TAI_HOME;
  else process.env.TAI_HOME = ORIGINAL;
});

describe("taiHome", () => {
  it("uses TAI_HOME when set", () => {
    process.env.TAI_HOME = "/srv/tai-work";
    expect(taiHome()).toBe("/srv/tai-work");
  });

  it("falls back to ~/.tailored-ai — the home the config and database already live in", () => {
    expect(taiHome()).toBe(join(homedir(), ".tailored-ai"));
  });

  it("resolves a relative TAI_HOME to an absolute path", () => {
    process.env.TAI_HOME = "relative-home";
    expect(taiHomePath("agent.db").startsWith("/")).toBe(true);
  });

  /**
   * The whole fix turns on this. `import` runs every module body before
   * `main()` parses `-c`, so a module that snapshots the answer into a
   * top-level `const` captures the value from *before* the CLI publishes it.
   * Such a module would keep pointing at the default home on every instance
   * started with `-c` — the fix present in the source and absent at runtime.
   */
  it("re-reads the environment on every call, never caching at import", () => {
    const before = taiHome();
    process.env.TAI_HOME = "/srv/tai-work";
    expect(taiHome()).toBe("/srv/tai-work");
    expect(taiHome()).not.toBe(before);
  });
});

describe("instance-scoped paths", () => {
  it("puts the trust store, resource cache and scratch under the same home", () => {
    process.env.TAI_HOME = "/srv/tai-work";

    expect(new TrustStore().storePath).toBe("/srv/tai-work/trust.json");
    expect(new ResourceLoader().cachePath).toBe("/srv/tai-work/cache/resources");
    expect(taiHomePath("exec-outputs")).toBe("/srv/tai-work/exec-outputs");
  });

  it("still lets an explicit path override the home", () => {
    process.env.TAI_HOME = "/srv/tai-work";
    expect(new TrustStore("/tmp/elsewhere/trust.json").storePath).toBe("/tmp/elsewhere/trust.json");
  });
});

describe("tool-output scratch", () => {
  const ctx = (boundary: string): ToolContext => ({
    sessionId: "s1",
    workingDirectory: "/repo",
    env: {},
    workingDirectoryBoundary: boundary,
  });

  it("writes the full output under this instance's home", async () => {
    process.env.TAI_HOME = join(process.env.CLAUDE_JOB_DIR ?? "/tmp", "tai-home-test");
    const capped = await capToolOutput("x".repeat(500), { toolName: "web_fetch", limit: 100, sessionId: "s1" });
    expect(capped).toContain(`${process.env.TAI_HOME}/tool-outputs/s1/`);
  });

  /**
   * The allowlist exists so a boundaried agent can read back the pointer we
   * handed it. It has to agree with where the writer actually wrote, and the
   * writer resolves against `TAI_HOME` at call time — so the allowlist must
   * too. Computed once at import, it named a directory nothing wrote to.
   */
  it("admits reads of scratch under a home set after this module loaded", () => {
    process.env.TAI_HOME = "/srv/tai-work";
    const r = checkSandboxBoundary("/srv/tai-work/tool-outputs/s1/web_fetch-abc.txt", ctx("/repo/.worktrees/agent/x"));
    expect(r.ok).toBe(true);
  });

  it("still admits the legacy ~/.tai scratch, because old pointers live in session history forever", () => {
    process.env.TAI_HOME = "/srv/tai-work";
    const old = join(legacyScratchHome(), "exec-outputs", "s0", "out.txt");
    expect(checkSandboxBoundary(old, ctx("/repo/.worktrees/agent/x")).ok).toBe(true);
  });

  it("does not admit an unrelated path just because a home is set", () => {
    process.env.TAI_HOME = "/srv/tai-work";
    const r = checkSandboxBoundary("/srv/tai-work/agent.db", ctx("/repo/.worktrees/agent/x"));
    expect(r.ok).toBe(false);
  });
});
