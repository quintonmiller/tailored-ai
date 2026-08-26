import { type AcpAgentSpec, type AcpPermissionPolicy, runAcpPrompt } from "../acp/client.js";
import type { AgentConfig } from "../config.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

type CodingAgentConfig = NonNullable<AgentConfig["tools"]["coding_agent"]>;

/**
 * Hand a coding task to another agent, over ACP.
 *
 * Named for what it does rather than for the protocol or for a vendor. The
 * model choosing it is picking "delegate this to a coding agent"; which agent
 * answers is the deployment's business, and ACP is how they talk.
 */
export class CodingAgentTool implements Tool {
  name = "coding_agent";
  description =
    "Delegate a coding task to an external coding agent. Give it a self-contained prompt: it does not see this conversation.";
  parameters = {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The task, stated in full. The agent has none of this conversation's context.",
      },
      agent: {
        type: "string",
        description: "Which configured agent to use. Omit for the default.",
      },
    },
    required: ["prompt"],
  };

  // Whatever it does to the working tree, we cannot describe or undo. The
  // derivability gate should get a look at an ambiguous delegation before a
  // subagent acts on the guess.
  effect = "irreversible" as const;

  constructor(private config: CodingAgentConfig) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) return { success: false, output: "", error: "No prompt provided." };

    const resolved = this.resolveAgent(typeof args.agent === "string" ? args.agent : undefined);
    if ("error" in resolved) return { success: false, output: "", error: resolved.error };

    const policy: AcpPermissionPolicy = this.config.permissions ?? "deny";

    try {
      const result = await runAcpPrompt({
        agent: resolved.agent,
        prompt,
        // The boundary, when the caller has one: a subagent that can write
        // anywhere is a hole straight through a containment the parent turn is
        // subject to.
        cwd: context.workingDirectoryBoundary ?? context.workingDirectory,
        policy,
        timeoutMs: this.config.timeoutMs,
      });

      const parts = [result.text.trim()];
      if (result.denied.length > 0) {
        // Said out loud rather than left for the reader to infer from a short
        // answer: a turn that was refused halfway looks like a turn that had
        // little to say, and the two want different responses.
        parts.push(
          `[${result.denied.length} action(s) refused by this deployment's policy: ${[...new Set(result.denied)].join(", ")}. ` +
            `Set tools.coding_agent.permissions: allow to let it act.]`,
        );
      }
      if (result.stopReason && result.stopReason !== "end_turn") {
        parts.push(`[the agent stopped early: ${result.stopReason}]`);
      }

      const output = parts.filter(Boolean).join("\n\n");
      return { success: true, output: output || "(the agent returned nothing)" };
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  /**
   * Pick the agent to run.
   *
   * Refuses loudly rather than falling back to some other entry: "the one you
   * named is missing so here is a different one" is how a task meant for a
   * sandboxed agent reaches an unsandboxed one.
   */
  private resolveAgent(requested: string | undefined): { agent: AcpAgentSpec } | { error: string } {
    const agents = this.config.agents ?? {};
    const names = Object.keys(agents);
    if (names.length === 0) {
      return { error: "No coding agents are configured. Add one under tools.coding_agent.agents." };
    }
    const name = requested ?? this.config.defaultAgent ?? (names.length === 1 ? names[0] : undefined);
    if (!name) {
      return {
        error: `Several agents are configured (${names.join(", ")}) and none is the default. Name one, or set tools.coding_agent.defaultAgent.`,
      };
    }
    const agent = agents[name];
    if (!agent) return { error: `Unknown agent "${name}". Configured: ${names.join(", ")}.` };
    return { agent };
  }
}
