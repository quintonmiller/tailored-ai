import { startTask } from "../agent/tasks.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";
import type { WorkflowEngine } from "../workflows/engine.js";
import type { WorkflowRegistry } from "../workflows/registry.js";

export interface RunWorkflowToolOptions {
  getEngine: () => WorkflowEngine | undefined;
  getRegistry: () => WorkflowRegistry;
}

/**
 * Invoke a workflow from within an agent loop. Synchronous by default — the
 * loop blocks until the workflow finishes and the final output is the tool
 * result. With `async: true` the run is fired and a runId is returned for
 * polling via task_status / HTTP.
 */
export class RunWorkflowTool implements Tool {
  name = "run_workflow";
  description = "Run a registered workflow with structured input. Returns the workflow's final output.";
  parameters = {
    type: "object",
    properties: {
      name: { type: "string", description: "Workflow name as registered in the runtime." },
      input: {
        type: "object",
        description: "JSON object exposed inside the workflow as ${input}.",
      },
      async: {
        type: "boolean",
        description: "If true, return a runId immediately and run in the background.",
      },
    },
    required: ["name"],
  };

  private getEngine: () => WorkflowEngine | undefined;
  private getRegistry: () => WorkflowRegistry;

  constructor(opts: RunWorkflowToolOptions) {
    this.getEngine = opts.getEngine;
    this.getRegistry = opts.getRegistry;
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const name = args.name;
    if (typeof name !== "string" || !name) {
      return { success: false, output: "", error: "name is required" };
    }
    const engine = this.getEngine();
    if (!engine) {
      return {
        success: false,
        output: "",
        error: "workflow engine is not configured in this runtime",
      };
    }
    if (!this.getRegistry().get(name)) {
      return { success: false, output: "", error: `unknown workflow: "${name}"` };
    }
    const input = (args.input ?? {}) as Record<string, unknown>;
    const runAsync = args.async === true;

    if (runAsync) {
      const info = startTask(`workflow:${name}`, async () => {
        const run = await engine.runWorkflow(name, input, "tool");
        return run.status === "completed"
          ? JSON.stringify(run.output)
          : `workflow ${run.status}: ${run.error ?? ""}`;
      });
      return { success: true, output: `Background workflow started: ${info.id}` };
    }

    try {
      const run = await engine.runWorkflow(name, input, "tool");
      if (run.status !== "completed") {
        return {
          success: false,
          output: "",
          error: `workflow ${run.status}: ${run.error ?? "no error message"}`,
        };
      }
      const out = run.output;
      const text = typeof out === "string" ? out : JSON.stringify(out ?? null);
      return { success: true, output: text };
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }
}
