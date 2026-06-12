/**
 * Built-in workflow step executor registration. Importing this module
 * side-effect-registers a factory for each bundled step type into the
 * process-scoped {@link globalStepExecutorRegistry}.
 *
 * `createWorkflowEngine` imports this module once, then calls
 * `runtime.getStepExecutorRegistry().buildAll(ctx)` to instantiate all
 * registered factories — built-ins and any plugin-registered factories in
 * the same pass. This means a plugin that calls
 * `ctx.stepExecutors.register(type, factory)` before `createWorkflowEngine`
 * runs will have its executor included automatically.
 *
 * Dogfoods the factory registry: if any built-in stops working, the
 * extension-point contract itself is broken and tests catch it.
 */

// Deferred import so this module doesn't create a runtime cycle —
// step-executor-registry imports from workflows/engine (for StepExecutor type)
// and we import from step-executor-registry here.
// Using a dynamic import at module evaluation time would require top-level
// await; instead we use a synchronous require-time side-effect by importing
// the registry through the known stable path.
import type { StepExecutorContext, StepExecutorRegistry } from "../resources/step-executor-registry.js";
import { createEgressPolicy } from "../security/egress-policy.js";
import { AgentRunExecutor } from "./executors/agent-run.js";
import { ChannelMessageExecutor } from "./executors/channel-message.js";
import { HttpRequestExecutor } from "./executors/http-request.js";
import { LoopExecutor } from "./executors/loop.js";
import { NotifyExecutor } from "./executors/notify.js";
import { ParallelExecutor } from "./executors/parallel.js";
import { ShellExecutor } from "./executors/shell.js";
import { ToolCallExecutor } from "./executors/tool-call.js";
import { TriggerWorkflowExecutor } from "./executors/trigger-workflow.js";
import { WorktreeExecutor } from "./executors/worktree.js";

/**
 * Module-level registry used for side-effect factory registration. The runtime
 * creates its own {@link StepExecutorRegistry} instance (`_stepExecutorRegistry`
 * on AgentRuntime), but built-in factories need a place to register at module
 * load time — before any runtime exists. `createWorkflowEngine` reads from the
 * runtime's registry, so we need to populate THAT registry, not a global one.
 *
 * Solution: export `registerBuiltinExecutorFactory` so the registration calls
 * below populate the runtime's registry when `populateBuiltinExecutors` is
 * called by `createWorkflowEngine`.
 */

type FactoryEntry = { type: string; factory: (ctx: StepExecutorContext) => import("./engine.js").StepExecutor };

const BUILTIN_FACTORIES: FactoryEntry[] = [];

function def(type: string, factory: (ctx: StepExecutorContext) => import("./engine.js").StepExecutor): void {
  BUILTIN_FACTORIES.push({ type, factory });
}

def("agent_run", ({ runtime, db }) => new AgentRunExecutor({ runtime, db }));

def(
  "tool_call",
  ({ runtime }) =>
    new ToolCallExecutor({
      getTools: () => runtime.getTools(),
      env: process.env as Record<string, string>,
    }),
);

def("shell", () => new ShellExecutor());

def("worktree", () => new WorktreeExecutor());

def("loop", () => new LoopExecutor());

def("parallel", () => new ParallelExecutor());

def(
  "channel_message",
  ({ resolveOutbound, getOwnerId, runtime }) =>
    new ChannelMessageExecutor({
      resolveOutbound,
      getOwnerId,
      // Implicit owner-DM fallbacks route through the form.completed event
      // (#205); explicit channel/user targets stay direct deliveries.
      events: runtime.events,
    }),
);

def("trigger_workflow", () => new TriggerWorkflowExecutor());

def(
  "http_request",
  ({ runtime }) =>
    new HttpRequestExecutor({
      egressPolicy: createEgressPolicy(runtime.getConfig().security?.egress),
    }),
);

def(
  "notify",
  ({ resolveOutbound, getOwnerId, getEmail, getDefaultEmailRecipients }) =>
    new NotifyExecutor({
      resolveOutbound,
      getOwnerId,
      getEmail,
      getDefaultEmailRecipients,
    }),
);

/**
 * Populate a {@link StepExecutorRegistry} with all built-in executor
 * factories. Called once by `createWorkflowEngine` on the runtime's registry.
 *
 * Idempotent: `registerBuiltinFactory` replaces any existing entry for the
 * same type, so calling this again on hot-reload doesn't double-register.
 */
export function populateBuiltinExecutors(registry: StepExecutorRegistry): void {
  for (const { type, factory } of BUILTIN_FACTORIES) {
    registry.registerBuiltinFactory(type, factory);
  }
}
