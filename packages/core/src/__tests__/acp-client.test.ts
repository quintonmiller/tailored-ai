/**
 * Driving another coding agent over ACP.
 *
 * The protocol half runs against a real SDK agent connected in-process, the way
 * `mcp-media.test.ts` runs the MCP client against a real `Server`. That is not
 * ceremony: the SDK hands client request handlers a *context* rather than bare
 * params, and a mocked SDK would have happily accepted the wrong shape and
 * shipped a permission handler that read `undefined` and denied everything for
 * the wrong reason.
 *
 * The permission decision itself is a pure function and is tested as one. It is
 * the security-relevant half — it decides whether a subagent may write to the
 * filesystem — and it should not need a subprocess to exercise.
 */
import { agent as acpAgent } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { type AcpPermissionRequest, decidePermission, runAcpPrompt } from "../acp/client.js";
import { CodingAgentTool } from "../tools/coding-agent.js";
import type { ToolContext } from "../tools/interface.js";

const OPTIONS: NonNullable<AcpPermissionRequest["options"]> = [
  { optionId: "yes", name: "Allow", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
  { optionId: "never", name: "Never", kind: "reject_always" },
];

describe("decidePermission", () => {
  it("refuses by default", () => {
    expect(decidePermission({ options: OPTIONS }, "deny")).toEqual({
      outcome: { outcome: "selected", optionId: "no" },
    });
  });

  it("prefers the one-shot option in both directions", () => {
    // A standing grant is a policy decision, and nothing here is entitled to
    // make one on the owner's behalf — in either direction.
    expect(decidePermission({ options: OPTIONS }, "allow")).toMatchObject({
      outcome: { optionId: "yes" },
    });
    expect(decidePermission({ options: OPTIONS }, "deny")).toMatchObject({
      outcome: { optionId: "no" },
    });
  });

  it("falls back to the standing option when there is no one-shot one", () => {
    const only = [OPTIONS[1], OPTIONS[3]];
    expect(decidePermission({ options: only }, "allow")).toMatchObject({ outcome: { optionId: "always" } });
    expect(decidePermission({ options: only }, "deny")).toMatchObject({ outcome: { optionId: "never" } });
  });

  it("cancels when the agent offers nothing it can use", () => {
    // Not "pick the first option": an agent's option list is its own, and
    // guessing by position is how a deny becomes an allow.
    expect(decidePermission({ options: [OPTIONS[0]] }, "deny")).toEqual({ outcome: { outcome: "cancelled" } });
    expect(decidePermission({ options: [] }, "allow")).toEqual({ outcome: { outcome: "cancelled" } });
    expect(decidePermission({}, "allow")).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

/**
 * A minimal agent that speaks the real protocol.
 *
 * `asks` makes it request permission before answering, which is the only way to
 * exercise the handler end to end.
 */
function fakeAgent(opts: { reply: string; asks?: boolean; stopReason?: string }) {
  return acpAgent({ name: "fake-agent" })
    .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .onRequest("session/new", () => ({ sessionId: "sess-1" }))
    .onRequest("session/prompt", async (ctx) => {
      let text = opts.reply;
      if (opts.asks) {
        const answer = await ctx.client.request("session/request_permission", {
          sessionId: "sess-1",
          toolCall: { toolCallId: "call-1", title: "write src/index.ts", kind: "edit" },
          options: OPTIONS,
        });
        const outcome = answer.outcome;
        text = outcome.outcome === "selected" ? `decided:${outcome.optionId}` : "decided:cancelled";
      }
      await ctx.client.notify("session/update", {
        sessionId: "sess-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
      return { stopReason: opts.stopReason ?? "end_turn" };
    });
}

function against(app: ReturnType<typeof fakeAgent>) {
  return async () => ({ stream: app as unknown, close: () => {}, stderr: () => "" });
}

describe("runAcpPrompt over the real protocol", () => {
  it("opens a session, sends the prompt, and returns what the agent said", async () => {
    const result = await runAcpPrompt({
      agent: { command: "unused" },
      prompt: "add a readme",
      cwd: "/work",
      policy: "deny",
      openStream: against(fakeAgent({ reply: "done" })),
    });

    expect(result.text).toBe("done");
    expect(result.sessionId).toBe("sess-1");
    expect(result.stopReason).toBe("end_turn");
    expect(result.denied).toEqual([]);
  });

  it("refuses what the agent asks for, and names it", async () => {
    const result = await runAcpPrompt({
      agent: { command: "unused" },
      prompt: "edit a file",
      cwd: "/work",
      policy: "deny",
      openStream: against(fakeAgent({ reply: "unused", asks: true })),
    });

    // The agent was told no, and the caller can say so rather than reporting a
    // short answer as if the agent had little to add.
    expect(result.text).toBe("decided:no");
    expect(result.denied).toEqual(["write src/index.ts"]);
  });

  it("lets it act when the deployment says so", async () => {
    const result = await runAcpPrompt({
      agent: { command: "unused" },
      prompt: "edit a file",
      cwd: "/work",
      policy: "allow",
      openStream: against(fakeAgent({ reply: "unused", asks: true })),
    });

    expect(result.text).toBe("decided:yes");
    expect(result.denied).toEqual([]);
  });

  it("surfaces a turn that stopped early", async () => {
    const result = await runAcpPrompt({
      agent: { command: "unused" },
      prompt: "go",
      cwd: "/work",
      policy: "deny",
      openStream: against(fakeAgent({ reply: "partial", stopReason: "max_tokens" })),
    });

    expect(result.stopReason).toBe("max_tokens");
  });
});

const CTX = { sessionId: "s", workingDirectory: "/work", env: {} } as ToolContext;

describe("the coding_agent tool", () => {
  it("refuses when nothing is configured, and says where to configure it", async () => {
    const tool = new CodingAgentTool({ enabled: true });
    const result = await tool.execute({ prompt: "go" }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toContain("tools.coding_agent.agents");
  });

  it("refuses an unknown agent rather than substituting one", async () => {
    // Silently running a different agent is how a task meant for a sandboxed
    // one reaches an unsandboxed one.
    const tool = new CodingAgentTool({ enabled: true, agents: { safe: { command: "a" } } });
    const result = await tool.execute({ prompt: "go", agent: "other" }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toContain("safe");
  });

  it("refuses to pick between several agents when none is the default", async () => {
    const tool = new CodingAgentTool({
      enabled: true,
      agents: { one: { command: "a" }, two: { command: "b" } },
    });
    const result = await tool.execute({ prompt: "go" }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toContain("defaultAgent");
  });

  it("uses the only configured agent without being told to", async () => {
    const tool = new CodingAgentTool({ enabled: true, agents: { only: { command: "definitely-not-a-binary" } } });
    const result = await tool.execute({ prompt: "go" }, CTX);
    // It got as far as trying to run it, which is the point — resolution
    // succeeded and the failure is the missing binary.
    expect(result.success).toBe(false);
    expect(result.error).not.toContain("defaultAgent");
  });

  it("rejects an empty prompt", async () => {
    const tool = new CodingAgentTool({ enabled: true, agents: { only: { command: "a" } } });
    expect(await tool.execute({ prompt: "   " }, CTX)).toMatchObject({ success: false });
  });

  it("declares itself irreversible, so the derivability gate sees it", async () => {
    // Whatever it does to the working tree, we cannot describe or undo.
    expect(new CodingAgentTool({ enabled: true }).effect).toBe("irreversible");
  });
});
