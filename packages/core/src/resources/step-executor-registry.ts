import type { StepExecutor } from "../workflows/engine.js";
import type { StepType } from "../workflows/types.js";
import type { Resource, ResourceManifest, ResourceOrigin } from "./interface.js";
import { ResourceRegistry } from "./registry.js";

/**
 * Construction context passed to every {@link StepExecutorFactory}. Contains
 * the dependencies that built-in executors need. Plugins receive the same
 * shape — use only what you need, ignore the rest.
 */
export interface StepExecutorContext {
  runtime: import("../runtime.js").AgentRuntime;
  db: import("better-sqlite3").Database;
  resolveOutbound: (channelId?: string) => import("../channels/outbound.js").OutboundNotifier | undefined;
  getOwnerId: (channelId?: string) => string | undefined;
  getEmail?: () => import("../workflows/executors/notify.js").EmailSender | undefined;
  getDefaultEmailRecipients?: () => string[];
}

/**
 * A factory that constructs a {@link StepExecutor} from a shared context.
 * Built-ins and plugin executors both use this shape: register via
 * {@link StepExecutorRegistry.registerBuiltinFactory} (built-ins) or
 * {@link StepExecutorRegistry.registerFactory} (plugins), then call
 * {@link StepExecutorRegistry.buildAll} inside `createWorkflowEngine` to
 * instantiate everything in one pass.
 */
export type StepExecutorFactory = (ctx: StepExecutorContext) => StepExecutor;

/**
 * Step executors exposed as a resource kind. Built-ins (agent_run, shell,
 * tool_call, …) register through {@link registerBuiltin}; community/agent-
 * authored executors can be loaded as ordinary `kind: step_executor`
 * resources whose body is a {@link StepExecutor} instance.
 *
 * Each `StepType` may have at most one active executor at a time. Registering
 * a second resource with the same step type replaces the active mapping
 * (same semantics as the underlying ResourceRegistry).
 *
 * **Plugin extension point**: plugins call {@link registerFactory} with a
 * factory function; `createWorkflowEngine` iterates all registered factories
 * (built-ins first, then plugin-registered) and instantiates them all. This
 * makes the construction path identical for built-ins and third-party
 * executors — no privileged hardcoded list.
 */
export class StepExecutorRegistry {
  /** type → resource id (so we can locate the active resource for a step type). */
  private byType = new Map<StepType, string>();
  /** Ordered list of registered factories. Built-ins first, plugin-registered appended. */
  private factories: Array<{ type: string; factory: StepExecutorFactory }> = [];

  constructor(private readonly resources: ResourceRegistry = new ResourceRegistry()) {
    // Keep the type index in sync with the underlying registry.
    this.resources.on((evt) => {
      if (evt.kind !== "step_executor") return;
      const slot = this.resources.get<StepExecutor>({ kind: "step_executor", id: evt.id });
      const stepType = slot?.body?.type as StepType | undefined;
      if (evt.type === "unregistered") {
        // Drop type entries that no longer resolve.
        for (const [t, id] of this.byType) {
          if (id === evt.id) this.byType.delete(t);
        }
      } else if (stepType) {
        this.byType.set(stepType, evt.id);
      }
    });
  }

  asResources(): ResourceRegistry {
    return this.resources;
  }

  registerBuiltin(executor: StepExecutor, opts: { id?: string; version?: string } = {}): void {
    const id = opts.id ?? `builtin/${executor.type}`;
    const manifest: ResourceManifest = {
      kind: "step_executor",
      id,
      version: opts.version ?? "0.0.0",
      description: `built-in executor for step type "${executor.type}"`,
      data: { stepType: executor.type },
    };
    const origin: ResourceOrigin = {
      scheme: "file",
      uri: `builtin:step_executor/${id}`,
      loadedAt: Date.now(),
    };
    this.resources.register({ manifest, origin, body: executor });
    this.byType.set(executor.type, id);
  }

  register(resource: Resource<StepExecutor>): void {
    if (resource.manifest.kind !== "step_executor") {
      throw new Error(`expected manifest.kind="step_executor", got "${resource.manifest.kind}"`);
    }
    this.resources.register(resource);
    if (resource.body?.type) this.byType.set(resource.body.type, resource.manifest.id);
  }

  unregister(id: string, version?: string): boolean {
    return this.resources.unregister({ kind: "step_executor", id, version });
  }

  /**
   * Register a factory for a built-in executor (see
   * `workflows/builtin-executors.ts`). First registration wins for a given
   * type, so re-populating on hot-reload is a no-op and never displaces a
   * plugin's override of that type.
   */
  registerBuiltinFactory(type: string, factory: StepExecutorFactory): void {
    // First registration wins: built-in factories are static module-level
    // data, so re-populating on hot-reload is a no-op — and a plugin that
    // already overrode this type (via registerFactory) keeps its override.
    if (this.factories.some((f) => f.type === type)) return;
    this.factories.push({ type, factory });
  }

  /**
   * Register a factory for a plugin-provided executor. Called from
   * `PluginContext.stepExecutors.register(type, factory)`. Plugin factories
   * are appended after built-ins so built-in types are always covered; a
   * plugin may override a built-in type by registering for the same type
   * string — the last-registered factory wins in {@link buildAll}.
   */
  registerFactory(type: string, factory: StepExecutorFactory): void {
    // Replace any existing entry for the same type (idempotent on reload).
    const idx = this.factories.findIndex((f) => f.type === type);
    if (idx !== -1) {
      this.factories[idx] = { type, factory };
    } else {
      this.factories.push({ type, factory });
    }
  }

  /**
   * Instantiate all registered factories with the given context and return
   * the resulting executors. Called once per `createWorkflowEngine` call.
   *
   * Each type has at most one factory in the list (registerFactory replaces
   * in place; registerBuiltinFactory never displaces an existing entry), so
   * a plugin that registered for a built-in type id is the one instantiated.
   */
  buildAll(ctx: StepExecutorContext): StepExecutor[] {
    const seen = new Map<string, StepExecutor>();
    for (const { factory } of this.factories) {
      const exec = factory(ctx);
      seen.set(exec.type, exec);
    }
    return Array.from(seen.values());
  }

  /** Look up the executor currently bound to a given step type. */
  getByType(type: StepType): StepExecutor | undefined {
    const id = this.byType.get(type);
    if (!id) return undefined;
    return this.resources.get<StepExecutor>({ kind: "step_executor", id })?.body;
  }

  /** Map view suitable for handing to {@link WorkflowEngine.registerExecutor}. */
  asMap(): Map<StepType, StepExecutor> {
    const out = new Map<StepType, StepExecutor>();
    for (const [type, id] of this.byType) {
      const exec = this.resources.get<StepExecutor>({ kind: "step_executor", id })?.body;
      if (exec) out.set(type, exec);
    }
    return out;
  }

  list(): StepExecutor[] {
    return this.resources
      .list<StepExecutor>("step_executor")
      .map((r) => r.body)
      .filter((x): x is StepExecutor => !!x);
  }
}
