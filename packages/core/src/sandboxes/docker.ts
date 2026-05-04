import {
  ContainerSandbox,
  type ContainerRunner,
  type ContainerRunResult,
  type ContainerSandboxOptions,
} from "./container.js";

/** Backwards-compatible alias. */
export type DockerRunner = ContainerRunner;
/** Backwards-compatible alias. */
export type DockerRunResult = ContainerRunResult;
/** Backwards-compatible alias. */
export type DockerSandboxOptions = ContainerSandboxOptions;

/**
 * Sandbox backed by a long-running Docker container with the host cwd
 * bind-mounted at `sandboxWorkdir` (default `/work`). One container per
 * `prepare()`; `exec()` runs `docker exec` inside it; `cleanup()` removes
 * the container. File reads/writes go to the host bind-mount path so the
 * sandbox doesn't need `docker cp` for the common case.
 */
export class DockerSandbox extends ContainerSandbox {
  constructor(opts: DockerSandboxOptions) {
    super("docker", "docker", opts);
  }
}
