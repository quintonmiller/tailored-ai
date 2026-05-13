import type { StepExecutor } from "../workflows/engine.js";
import type { StepType } from "../workflows/types.js";
import type { Resource, ResourceManifest, ResourceOrigin } from "./interface.js";
import { ResourceRegistry } from "./registry.js";

/**
 * Step executors exposed as a resource kind. Built-ins (agent_run, shell,
 * tool_call, …) register through {@link registerBuiltin}; community/agent-
 * authored executors can be loaded as ordinary `kind: step_executor`
 * resources whose body is a {@link StepExecutor} instance.
 *
 * Each `StepType` may have at most one active executor at a time. Registering
 * a second resource with the same step type replaces the active mapping
 * (same semantics as the underlying ResourceRegistry).
 */
export class StepExecutorRegistry {
  /** type → resource id (so we can locate the active resource for a step type). */
  private byType = new Map<StepType, string>();

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
