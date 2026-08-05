/**
 * Deploy-target contract.
 *
 * A deploy target answers "put this TAI instance somewhere": a container on
 * this machine, an EC2 box, a Fly app, a Hetzner VM. TAI ships one built-in
 * target (`docker`); everything else is a plugin package.
 *
 * **Types only, deliberately.** There is no registry and no runtime code here.
 * Deployment is a CLI-time concern — the agent runtime never needs to know how
 * it was deployed, so shipping an implementation in the runtime library would
 * be weight every embedder pays for and nobody uses. The registry, the
 * discovery, and the `tai deploy` command all live in `@tailored-ai/cli`.
 *
 * The contract lives in core anyway because that is the package every plugin
 * already depends on. A plugin author writes:
 *
 * ```ts
 * import type { DeployTarget } from "@tailored-ai/core";
 * export const deployTargets: DeployTarget[] = [ ... ];
 * ```
 *
 * and the import erases at compile time, so the runtime dependency is nil.
 *
 * ## Why a named export instead of `register(ctx)`
 *
 * Every other extension point registers through `PluginContext` during
 * `loadPlugins`, which requires a loaded `config.yaml`. Deploy targets cannot:
 * `tai deploy` is frequently the command that CREATES the instance, so it has
 * to enumerate targets before any config exists. The CLI therefore imports
 * installed plugin modules and reads a `deployTargets` named export — the same
 * shape the loader already uses for the optional `meta` and `validateConfig`
 * exports.
 */

/** What a target needs to know about the instance being deployed. */
export interface DeployContext {
  /** Resolved `TAI_HOME` — the directory that holds config, db, and plugins. */
  homeDir: string;
  /** Absolute path to config.yaml. May not exist yet on a first deploy. */
  configPath: string;
  /** Repo root, when the CLI is running from a source checkout. */
  repoRoot?: string;
  /** Target-specific arguments: everything after `--` on the command line. */
  args: string[];
  /** Print progress. Targets should use this rather than console.log. */
  log(message: string): void;
}

/** One step a target intends to take. Produced by `plan`, printed by the CLI. */
export interface DeployStep {
  /** Imperative one-liner: "build image tai:local". */
  title: string;
  /** The command that will run, when the step is a shell-out. */
  command?: string;
  /**
   * True when this step changes something outside the local machine, costs
   * money, or is hard to undo. The CLI surfaces these separately so a plan is
   * skimmable for the parts that matter.
   */
  consequential?: boolean;
}

export interface DeployPlan {
  steps: DeployStep[];
  /**
   * Conditions the target checked and found wanting — a missing binary, an
   * absent credential, a port already bound. Non-empty means `up` would fail,
   * so the CLI reports these and exits non-zero rather than starting work it
   * knows will not finish.
   */
  problems?: string[];
  /** Free-form notes worth reading before running `up`. */
  notes?: string[];
}

export interface DeployResult {
  ok: boolean;
  /** One-line summary for the operator. */
  summary: string;
  /** Where the thing now lives, when there is a URL to hand back. */
  url?: string;
  details?: string[];
}

export interface DeployStatus {
  /** "running", "stopped", "not deployed", … — target's own vocabulary. */
  state: string;
  url?: string;
  details?: string[];
}

export interface DeployTarget {
  /** Selector used on the command line: `tai deploy up <id>`. */
  id: string;
  /** One line, shown by `tai deploy list`. */
  description: string;
  /** Longer help shown by `tai deploy help <id>`, including its own flags. */
  help?: string;

  /**
   * Describe what `up` would do, without doing any of it. Must not create,
   * modify, or destroy anything — `plan` is what an operator runs to decide
   * whether to trust the target.
   */
  plan(ctx: DeployContext): Promise<DeployPlan>;

  /** Create or update the deployment. */
  up(ctx: DeployContext): Promise<DeployResult>;

  /** Tear it down. Omit when the target has nothing meaningful to remove. */
  down?(ctx: DeployContext): Promise<DeployResult>;

  /** Report what is currently deployed. */
  status?(ctx: DeployContext): Promise<DeployStatus>;
}

/**
 * The named export a plugin uses to contribute targets.
 *
 * ```ts
 * export const deployTargets: DeployTargets = [myTarget];
 * ```
 */
export type DeployTargets = DeployTarget[];
