import type { AgentConfig, AgentDefinition } from "../config.js";
import { HostSandbox } from "./host.js";
import type { Sandbox, SandboxKind } from "./interface.js";

/**
 * Resolve the sandbox an agent should run in. Looks at the agent's `sandbox`
 * field first, then falls back to a future global default. Today only the
 * `host` sandbox is implemented; `docker` and `podman` slots reserve the type.
 */
export function createSandbox(config: AgentConfig, agent?: AgentDefinition): Sandbox {
  const kind: SandboxKind = (agent?.sandbox ?? config.agent.sandbox ?? "host") as SandboxKind;
  switch (kind) {
    case "host":
      return new HostSandbox();
    case "docker":
    case "podman":
      throw new Error(
        `Sandbox "${kind}" is not yet implemented. Only "host" is available; see follow-up beans linked from S2.`,
      );
    default:
      throw new Error(`Unknown sandbox kind "${kind}"`);
  }
}
