import { ContainerSandbox, type ContainerSandboxOptions } from "./container.js";

export type PodmanSandboxOptions = ContainerSandboxOptions;

/**
 * Sandbox backed by a long-running rootless Podman container. Identical
 * lifecycle and surface to `DockerSandbox`; the underlying CLI is
 * effectively interchangeable for the operations we use (run/exec/rm).
 */
export class PodmanSandbox extends ContainerSandbox {
  constructor(opts: PodmanSandboxOptions) {
    super("podman", "podman", opts);
  }
}
