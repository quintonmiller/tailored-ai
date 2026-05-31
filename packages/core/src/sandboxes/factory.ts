import type { AgentConfig, AgentDefinition } from "../config.js";
import { DockerSandbox } from "./docker.js";
import { HostSandbox } from "./host.js";
import type { Sandbox, SandboxKind } from "./interface.js";
import { PodmanSandbox } from "./podman.js";

/**
 * Resolve the sandbox an agent should run in. Looks at the agent's `sandbox`
 * field first, then falls back to `config.agent.sandbox`, then `host`.
 */
export function createSandbox(config: AgentConfig, agent?: AgentDefinition): Sandbox {
  const kind: SandboxKind = (agent?.sandbox ?? config.agent.sandbox ?? "host") as SandboxKind;
  switch (kind) {
    case "host":
      return new HostSandbox();
    case "docker": {
      const cfg = config.sandboxes?.docker;
      if (!cfg?.imageName) {
        throw new Error('Sandbox "docker" requires sandboxes.docker.imageName in config');
      }
      return new DockerSandbox({
        imageName: cfg.imageName,
        mounts: cfg.mounts,
        env: cfg.env,
        network: cfg.network,
        sandboxWorkdir: cfg.sandboxWorkdir,
      });
    }
    case "podman": {
      const cfg = config.sandboxes?.podman;
      if (!cfg?.imageName) {
        throw new Error('Sandbox "podman" requires sandboxes.podman.imageName in config');
      }
      return new PodmanSandbox({
        imageName: cfg.imageName,
        mounts: cfg.mounts,
        env: cfg.env,
        network: cfg.network,
        sandboxWorkdir: cfg.sandboxWorkdir,
      });
    }
    default:
      throw new Error(`Unknown sandbox kind "${kind}"`);
  }
}
