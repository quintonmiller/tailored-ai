import type { AgentConfig, AgentDefinition } from "../config.js";
import { Registry } from "../registry.js";
import { DockerSandbox } from "./docker.js";
import { HostSandbox } from "./host.js";
import type { Sandbox } from "./interface.js";
import { PodmanSandbox } from "./podman.js";

/**
 * Factory signature for a sandbox backend. Receives the full agent config
 * (to read `sandboxes.<id>.*` options) and returns a `Sandbox` instance.
 *
 * Built-in factories (host / docker / podman) are registered at the bottom
 * of this module — same module-load pattern as `providers/factories.ts`, so
 * any code path that can call `createSandbox` is guaranteed to see them.
 * Third-party plugins register additional kinds via `registerSandboxFactory`.
 */
export type SandboxFactory = (config: AgentConfig) => Sandbox;

export const sandboxFactoryRegistry = new Registry<SandboxFactory>("sandbox");

export function registerSandboxFactory(id: string, factory: SandboxFactory): void {
  sandboxFactoryRegistry.register(id, factory);
}

/**
 * Resolve the sandbox an agent should run in. Looks at the agent's `sandbox`
 * field first, then falls back to `config.agent.sandbox`, then `"host"`.
 *
 * Throws with a clear "Known: …" message when the resolved kind has no
 * registered factory, mirroring the task/repo-backend pattern.
 */
export function createSandbox(config: AgentConfig, agent?: AgentDefinition): Sandbox {
  const kind = agent?.sandbox ?? config.agent.sandbox ?? "host";
  const factory = sandboxFactoryRegistry.get(kind);
  if (!factory) {
    const known = sandboxFactoryRegistry.list().join(", ") || "(none)";
    throw new Error(
      `Unknown sandbox kind "${kind}". Known: ${known}. Register a custom sandbox with registerSandboxFactory().`,
    );
  }
  return factory(config);
}

// ---------------------------------------------------------------------------
// Built-in registrations. Colocated with the registry (rather than a separate
// side-effect module) so importing `createSandbox` from anywhere — runtime,
// workflows, tests — always finds them; a barrel-only side-effect import
// would leave the registry empty for consumers that bypass the barrel.
// They still go through `registerSandboxFactory`, the same path a plugin uses.
// ---------------------------------------------------------------------------

registerSandboxFactory("host", () => new HostSandbox());

registerSandboxFactory("docker", (config) => {
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
});

registerSandboxFactory("podman", (config) => {
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
});
