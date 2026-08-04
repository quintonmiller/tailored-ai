/**
 * Per-agent exec rules.
 *
 * The deployment allowlist is one list on one shared ExecTool instance, so
 * granting `exec` to an agent granted everything on it — 34 commands including
 * `rm`, `curl` and `python3` in the reference deployment. That made `exec`
 * un-grantable for a single narrow purpose, which is the whole reason an
 * integration ends up as a bespoke custom tool instead.
 *
 * Two properties carry the safety here:
 *
 *  - `intersect` (the default) means an agent can only ever narrow. A typo in
 *    one agent's block must not grant something the deployment never listed.
 *  - an allow list that intersects to nothing must deny everything, not fall
 *    back to "unrestricted". That is the direction that fails open.
 *
 * The last test asserts the rules arrive at ExecTool.execute rather than
 * stopping at resolveAgent, because that exact gap already shipped once: three
 * agents ran with a declared `fileBoundary` that never reached
 * `toolContextExtras` and therefore did nothing at all.
 */
import { describe, expect, it } from "vitest";
import { type CommandRules, checkCommandRules, mergeCommandRules } from "../tools/command-allowlist.js";
import { ExecTool } from "../tools/exec.js";
import type { ToolContext } from "../tools/interface.js";

const DEPLOYMENT: CommandRules = { allow: ["ls", "git", "rm", "python3", "ntn"] };

function ctx(execRules?: CommandRules): ToolContext {
  return { sessionId: "s1", workingDirectory: process.cwd(), env: {}, execRules };
}

const run = (tool: ExecTool, command: string, context: ToolContext) => tool.execute({ command }, context);

describe("mergeCommandRules", () => {
  it("narrows to the agent's list under intersect", () => {
    const merged = mergeCommandRules(DEPLOYMENT, { allow: ["ntn"] });
    expect(merged.allow).toEqual(["ntn"]);
  });

  it("cannot widen beyond the deployment under intersect", () => {
    const merged = mergeCommandRules(DEPLOYMENT, { allow: ["ntn", "curl", "docker"] });
    expect(merged.allow).toEqual(["ntn"]);
  });

  it("denies everything when the two lists are disjoint", () => {
    // The failure to avoid: [] collapsing back into "unrestricted".
    const merged = mergeCommandRules(DEPLOYMENT, { allow: ["docker"] });
    expect(merged.allow).toEqual([]);
    expect(checkCommandRules("ls", merged).ok).toBe(false);
    expect(checkCommandRules("docker ps", merged).ok).toBe(false);
  });

  it("lets an agent replace the deployment list under override", () => {
    const merged = mergeCommandRules(DEPLOYMENT, { allow: ["docker"] }, "override");
    expect(merged.allow).toEqual(["docker"]);
    expect(checkCommandRules("docker ps", merged).ok).toBe(true);
  });

  it("keeps the deployment rules when the agent declares none", () => {
    expect(mergeCommandRules(DEPLOYMENT, undefined).allow).toEqual(DEPLOYMENT.allow);
    expect(mergeCommandRules(DEPLOYMENT, {}).allow).toEqual(DEPLOYMENT.allow);
  });

  it("unions denies, and a deployment deny survives intersect", () => {
    const merged = mergeCommandRules({ allow: ["git", "rm"], deny: ["rm"] }, { allow: ["git", "rm"] });
    expect(merged.deny).toContain("rm");
    expect(checkCommandRules("rm -rf /", merged).ok).toBe(false);
    expect(checkCommandRules("git status", merged).ok).toBe(true);
  });
});

describe("command rules — deny and patterns", () => {
  it("deny wins over allow", () => {
    const rules = mergeCommandRules({ allow: ["git", "rm"], deny: ["rm"] }, undefined);
    expect(checkCommandRules("rm file", rules).ok).toBe(false);
    expect(checkCommandRules("rm file", rules).error).toContain("blocked");
  });

  it("matches glob patterns in both lists", () => {
    const allow = mergeCommandRules({ allow: ["ntn*", "git"] }, undefined);
    expect(checkCommandRules("ntn", allow).ok).toBe(true);
    expect(checkCommandRules("ntnx", allow).ok).toBe(true);
    expect(checkCommandRules("notion", allow).ok).toBe(false);

    const deny = mergeCommandRules({ deny: ["*sh"] }, undefined);
    expect(checkCommandRules("bash -c x", deny).ok).toBe(false);
    expect(checkCommandRules("zsh", deny).ok).toBe(false);
    expect(checkCommandRules("ls", deny).ok).toBe(true);
  });

  it("applies rules to every command position in a compound command", () => {
    const rules = mergeCommandRules({ allow: ["ntn"] }, undefined);
    expect(checkCommandRules("ntn api v1/users", rules).ok).toBe(true);
    expect(checkCommandRules("ntn api v1/users && rm -rf /", rules).ok).toBe(false);
    expect(checkCommandRules("ntn api v1/users | python3", rules).ok).toBe(false);
  });

  it("is unrestricted when neither list is set", () => {
    expect(checkCommandRules("anything at all", mergeCommandRules(undefined, undefined)).ok).toBe(true);
  });
});

describe("ExecTool — per-agent rules reach execution", () => {
  it("refuses a deployment-allowed command the agent's rules exclude", async () => {
    const tool = new ExecTool(DEPLOYMENT);

    // Same tool instance, same command, different agent context.
    const unscoped = await run(tool, "ls", ctx());
    expect(unscoped.success).toBe(true);

    const scoped = await run(tool, "ls", ctx({ allow: ["ntn"] }));
    expect(scoped.success).toBe(false);
    expect(scoped.error).toContain("not in the allowlist");
  });

  it("honours a deployment-level deny for every agent", async () => {
    const tool = new ExecTool({ allow: ["ls", "rm"], deny: ["rm"] });
    const result = await run(tool, "rm -rf /tmp/nope", ctx({ allow: ["rm"] }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked");
  });

  it("lets override widen when the deployment opted into it", async () => {
    const intersecting = new ExecTool({ allow: ["ls"] });
    expect((await run(intersecting, "echo hi", ctx({ allow: ["echo"] }))).success).toBe(false);

    const overriding = new ExecTool({ allow: ["ls"] }, undefined, undefined, "override");
    expect((await run(overriding, "echo hi", ctx({ allow: ["echo"] }))).success).toBe(true);
  });

  it("still accepts the legacy array constructor argument", async () => {
    const tool = new ExecTool(["echo"]);
    expect((await run(tool, "echo hi", ctx())).success).toBe(true);
    expect((await run(tool, "ls", ctx())).success).toBe(false);
  });
});
