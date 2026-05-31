import { ApprovalGate } from "../resources/approval-gate.js";
import type {
  Resource,
  ResourceKind,
  ResourceManifest,
  ResourceOrigin,
  ResourcePermissions,
} from "../resources/interface.js";
import { ResourceLoader } from "../resources/loader.js";
import { validateManifest } from "../resources/manifest.js";
import { parseSkillData } from "../resources/skill.js";
import { AgentResourceSource } from "../resources/sources/agent.js";
import type { AgentRuntime } from "../runtime.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface ResourceAdminToolOptions {
  runtime: AgentRuntime;
  loader?: ResourceLoader;
  approvalGate?: ApprovalGate;
  /** Caller-permission cap when agents install resources. null = unrestricted. */
  agentPermissions?: ResourcePermissions | null;
}

/**
 * Agent-facing tool for managing every resource kind through a single
 * surface. Supersedes the workflow-specific authoring path tracked by
 * ptask_1489015d. Calls into:
 *
 *  - the {@link AgentResourceSource} (for `create` / `update` of ephemeral
 *    agent-authored resources)
 *  - the {@link ResourceLoader} (for `install` of file:// / https:// / git+ /
 *    npm: / agent:// URIs)
 *  - the kind-specific facade registries (ToolRegistry, SkillRegistry, ...)
 *    so the resource shows up wherever it's consumed
 *  - the {@link ApprovalGate} for trust + permission enforcement on install
 */
export class ResourceAdminTool implements Tool {
  name = "resource_admin";
  description = "Create, install, list, or remove TAI resources (tools, skills, prompts, workflows, etc.).";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "update", "delete", "list", "inspect", "install", "uninstall"],
        description:
          "create/update authors a resource at runtime (agent://); install fetches from a URI; uninstall removes a previously-installed resource.",
      },
      kind: {
        type: "string",
        description: "Resource kind: tool, provider, skill, prompt, kb, workflow, step_executor, trigger.",
      },
      id: { type: "string", description: "Resource id, e.g. my-org/foo." },
      version: { type: "string", description: "Optional version (defaults to 0.0.0 for new resources)." },
      manifest: {
        type: "object",
        description: "Full manifest object for create/update. Required permissions field is supported.",
      },
      uri: {
        type: "string",
        description: "Resource URI for install (file://, https://, git+https://, npm:, agent://, tai-registry:).",
      },
    },
    required: ["action"],
  };

  private runtime: AgentRuntime;
  private loader: ResourceLoader;
  private gate: ApprovalGate;
  private agentSource: AgentResourceSource;
  private agentPermissions: ResourcePermissions | null;

  constructor(opts: ResourceAdminToolOptions) {
    this.runtime = opts.runtime;
    this.loader = opts.loader ?? new ResourceLoader();
    this.gate = opts.approvalGate ?? new ApprovalGate();
    this.agentSource =
      (this.loader.getSource<AgentResourceSource>("agent") as AgentResourceSource | undefined) ??
      new AgentResourceSource();
    if (!this.loader.getSource("agent")) {
      this.loader.addSource(this.agentSource);
    }
    this.agentPermissions = opts.agentPermissions ?? null;
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = args.action as string;
    try {
      switch (action) {
        case "create":
        case "update":
          return await this.author(args, ctx, action === "update");
        case "delete":
          return this.deleteResource(args);
        case "list":
          return this.listResources(args);
        case "inspect":
          return this.inspectResource(args);
        case "install":
          return await this.install(args, ctx);
        case "uninstall":
          return this.uninstall(args);
        default:
          return fail(`unknown action "${action}". Valid: create, update, delete, list, inspect, install, uninstall.`);
      }
    } catch (err) {
      return fail((err as Error).message);
    }
  }

  // ---- create / update (agent://) ----

  private async author(args: Record<string, unknown>, ctx: ToolContext, update: boolean): Promise<ToolResult> {
    if (!args.manifest || typeof args.manifest !== "object") {
      return fail(`manifest object is required for ${update ? "update" : "create"}.`);
    }
    const manifest = validateManifest(args.manifest);
    if (args.id && manifest.id !== args.id) {
      return fail(`manifest.id "${manifest.id}" does not match args.id "${args.id}".`);
    }
    // Permission narrowing — agent-authored resources can't request more than
    // the agent itself holds.
    if (manifest.permissions) {
      const { clampPermissions } = await import("../resources/approval-gate.js");
      manifest.permissions = clampPermissions(manifest.permissions, this.agentPermissions);
    }

    const uri = this.agentSource.publish({
      sessionId: ctx.sessionId,
      manifest,
      rootPath: ctx.workingDirectory,
    });
    const res = await this.loader.load(uri);
    // For kinds whose body shape is well-known, derive it from manifest.data so
    // the kind-specific facades (PromptRegistry.get, SkillRegistry.get, ...)
    // return a usable value rather than null.
    deriveBodyForKnownKinds(res);
    this.registerInTargetRegistry(res);
    return ok(`${update ? "updated" : "created"} ${manifest.kind}/${manifest.id}@${manifest.version} (${uri})`);
  }

  // ---- delete / uninstall ----

  private deleteResource(args: Record<string, unknown>): ToolResult {
    const { kind, id } = requireKindId(args);
    const reg = this.registryForKind(kind);
    if (!reg) return fail(`no registry available for kind "${kind}".`);
    const removed = reg.unregister({ kind, id });
    return removed ? ok(`deleted ${kind}/${id}`) : fail(`${kind}/${id} not found`);
  }

  private uninstall(args: Record<string, unknown>): ToolResult {
    const { kind, id } = requireKindId(args);
    const reg = this.registryForKind(kind);
    if (!reg) return fail(`no registry available for kind "${kind}".`);
    const removed = reg.unregister({ kind, id });
    this.gate.getTrustStore().revokeResource(kind, id);
    return removed ? ok(`uninstalled ${kind}/${id}`) : fail(`${kind}/${id} not found`);
  }

  // ---- list / inspect ----

  private listResources(args: Record<string, unknown>): ToolResult {
    const kind = args.kind as ResourceKind | undefined;
    const out: Array<{ kind: string; id: string; version: string; origin: string }> = [];
    for (const reg of this.allRegistries()) {
      for (const r of reg.list()) {
        if (!kind || r.manifest.kind === kind) {
          out.push({
            kind: r.manifest.kind,
            id: r.manifest.id,
            version: r.manifest.version,
            origin: r.origin.uri,
          });
        }
      }
    }
    return ok(JSON.stringify(out, null, 2));
  }

  private inspectResource(args: Record<string, unknown>): ToolResult {
    const { kind, id } = requireKindId(args);
    const reg = this.registryForKind(kind);
    if (!reg) return fail(`no registry available for kind "${kind}".`);
    const res = reg.get({ kind, id });
    if (!res) return fail(`${kind}/${id} not found`);
    return ok(
      JSON.stringify(
        {
          manifest: res.manifest,
          origin: res.origin,
        },
        null,
        2,
      ),
    );
  }

  // ---- install ----

  private async install(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    if (typeof args.uri !== "string" || args.uri.length === 0) {
      return fail("uri is required for install");
    }
    const res = await this.loader.load(args.uri);
    const decision = await this.gate.decide({
      resource: res,
      callerPermissions: this.agentPermissions,
    });
    if (!decision.approved) {
      return fail(`install denied: ${decision.reason}`);
    }
    // Replace whatever permissions the manifest requested with the granted set.
    res.manifest.permissions = decision.grantedPermissions;
    this.registerInTargetRegistry(res);
    return ok(
      `installed ${res.manifest.kind}/${res.manifest.id}@${res.manifest.version} from ${args.uri} (${decision.cached ? "cached" : "approved"})`,
    );
  }

  // ---- registry plumbing ----

  private registerInTargetRegistry(res: Resource): void {
    const r = this.runtime;
    switch (res.manifest.kind) {
      case "tool":
        r.getToolRegistry().asResources().register(res);
        break;
      case "provider":
        r.getProviderRegistry().asResources().register(res);
        break;
      case "skill":
        r.getSkillRegistry().asResources().register(res);
        break;
      case "prompt":
        r.getPromptRegistry().asResources().register(res);
        break;
      case "kb":
        r.getKbRegistry().asResources().register(res);
        break;
      case "step_executor":
        r.getStepExecutorRegistry().asResources().register(res);
        break;
      case "trigger":
        r.getTriggerRegistry().asResources().register(res);
        break;
      case "agent":
        r.getAgentRegistry().asResources().register(res);
        break;
      case "bundle":
        r.getBundleRegistry()
          .asResources()
          .register(res as never);
        break;
      case "workflow":
      case "channel":
      case "sandbox":
      case "task_backend":
        // No facade registry yet — surface goes through the workflow / channel
        // registries that already exist for these kinds. The base resource
        // record is still tracked so `list` / `inspect` work.
        break;
    }
  }

  /** Walk every kind-specific resource registry exposed by the runtime. */
  private *allRegistries(): IterableIterator<{
    list: () => Array<{ manifest: ResourceManifest; origin: ResourceOrigin }>;
    get: (ref: { kind: ResourceKind; id: string; version?: string }) => Resource | undefined;
    unregister: (ref: { kind: ResourceKind; id: string; version?: string }) => boolean;
  }> {
    yield this.runtime.getToolRegistry().asResources() as any;
    yield this.runtime.getProviderRegistry().asResources() as any;
    yield this.runtime.getSkillRegistry().asResources() as any;
    yield this.runtime.getPromptRegistry().asResources() as any;
    yield this.runtime.getKbRegistry().asResources() as any;
    yield this.runtime.getStepExecutorRegistry().asResources() as any;
    yield this.runtime.getTriggerRegistry().asResources() as any;
    yield this.runtime.getAgentRegistry().asResources() as any;
    yield this.runtime.getBundleRegistry().asResources() as any;
  }

  private registryForKind(kind: ResourceKind):
    | {
        list: () => Array<{ manifest: ResourceManifest; origin: ResourceOrigin }>;
        get: (ref: { kind: ResourceKind; id: string; version?: string }) => Resource | undefined;
        unregister: (ref: { kind: ResourceKind; id: string; version?: string }) => boolean;
      }
    | undefined {
    const r = this.runtime;
    switch (kind) {
      case "tool":
        return r.getToolRegistry().asResources() as any;
      case "provider":
        return r.getProviderRegistry().asResources() as any;
      case "skill":
        return r.getSkillRegistry().asResources() as any;
      case "prompt":
        return r.getPromptRegistry().asResources() as any;
      case "kb":
        return r.getKbRegistry().asResources() as any;
      case "step_executor":
        return r.getStepExecutorRegistry().asResources() as any;
      case "trigger":
        return r.getTriggerRegistry().asResources() as any;
      case "agent":
        return r.getAgentRegistry().asResources() as any;
      case "bundle":
        return r.getBundleRegistry().asResources() as any;
      default:
        return undefined;
    }
  }
}

function deriveBodyForKnownKinds(res: Resource): void {
  if (res.body) return;
  const { manifest } = res;
  const data = (manifest.data ?? {}) as Record<string, unknown>;
  switch (manifest.kind) {
    case "prompt": {
      const text = typeof data.text === "string" ? data.text : "";
      (res as Resource<{ text: string }>).body = { text };
      break;
    }
    case "skill": {
      (res as Resource<{ manifest: ResourceManifest; definition: any }>).body = {
        manifest,
        definition: parseSkillData(manifest),
      };
      break;
    }
    case "kb": {
      const rootPath = typeof data.rootPath === "string" ? data.rootPath : "";
      (res as Resource<{ rootPath: string; description?: string }>).body = {
        rootPath,
        description: manifest.description,
      };
      break;
    }
    default:
      // Tools, providers, step executors, etc. need real instance bodies that
      // can only come from compiled code (S8.6b worker-sandbox slice). Leave
      // body as-is — the resource record still surfaces via `list` / `inspect`.
      break;
  }
}

function requireKindId(args: Record<string, unknown>): { kind: ResourceKind; id: string } {
  if (typeof args.kind !== "string" || typeof args.id !== "string") {
    throw new Error("kind and id are required");
  }
  return { kind: args.kind as ResourceKind, id: args.id };
}

function ok(output: string): ToolResult {
  return { success: true, output };
}

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}
