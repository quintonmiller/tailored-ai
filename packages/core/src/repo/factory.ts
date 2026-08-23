/**
 * Repo backend registry + resolver — Slice 4 of the platform vision
 * (`docs/platform-vision.md`). Mirrors `tasks/factory.ts`: a string-keyed
 * `Registry` of factories, built-ins registered on module load, and a
 * `createRepoBackend` resolver driven by config.
 *
 * Unlike the task backend, the repo backend is **opt-in**: with no
 * `repo.backend` configured, `createRepoBackend` returns undefined and
 * nothing pushes or opens proposals — preserving today's behavior, where
 * the coder commits and the host/user integrates by hand. Setting
 * `repo.backend: github` lights up the default `gh` implementation.
 */

import type { AgentConfig } from "../config.js";
import type { EventBus } from "../events.js";
import { type Disposer, Registry } from "../registry.js";
import { GhRepoBackend } from "./github.js";
import type { RepoBackend } from "./interface.js";

export interface RepoBackendDeps {
  /** Bus the backend emits repo.proposal.* events to. */
  events?: EventBus;
}

export type RepoBackendFactory = (config: AgentConfig, deps: RepoBackendDeps) => RepoBackend;

export const repoBackendFactoryRegistry = new Registry<RepoBackendFactory>("repo-backend");

export function registerRepoBackendFactory(id: string, factory: RepoBackendFactory): Disposer {
  return repoBackendFactoryRegistry.register(id, factory);
}

// Built-in repo backends register on module load. The github backend reads
// its options from the generic `repo.options` bag — exactly how a
// third-party backend would — so core privileges no built-in.

repoBackendFactoryRegistry.register("github", (config, deps) => {
  const opts = config.repo?.options ?? {};
  const taskOpts = config.tasks?.options ?? {};
  return new GhRepoBackend({
    // Fall back to the github task backend's coordinates so a user who
    // already configured it doesn't repeat themselves.
    repo: asString(opts.repo) ?? asString(taskOpts.repo),
    token: asString(opts.token) ?? asString(taskOpts.token),
    defaultBase: config.repo?.defaultBase,
    remote: config.repo?.remote,
    events: deps.events,
  });
});

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Construct the configured repo backend, or undefined when none is set
 * (`repo.backend` unset or "none"). Custom backends register via
 * `registerRepoBackendFactory`.
 */
export function createRepoBackend(config: AgentConfig, deps: RepoBackendDeps = {}): RepoBackend | undefined {
  const kind = config.repo?.backend;
  if (!kind || kind === "none") return undefined;
  const factory = repoBackendFactoryRegistry.get(kind);
  if (!factory) {
    const known = repoBackendFactoryRegistry.list().join(", ") || "(none)";
    throw new Error(
      `Unsupported repo.backend "${kind}". Known: ${known}. Register a custom backend with registerRepoBackendFactory().`,
    );
  }
  return factory(config, deps);
}
