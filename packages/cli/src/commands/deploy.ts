/**
 * `tai deploy` — put this instance somewhere.
 *
 * The command is a thin driver: resolve the target, build a context, call one
 * of plan/up/down/status, print the result. All the judgment lives in the
 * targets, which is the point — TAI ships `docker` and everything else
 * (AWS, GCP, Fly, Hetzner) is a plugin that registers through the same seam.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DeployContext, DeployTarget } from "@tailored-ai/core";
import { discoverDeployTargets } from "../deploy/registry.js";
import { adoptHomeDir } from "../home.js";

const USAGE = `Usage: tai deploy <command> [target] [-- <target args>]

Commands:
  list                    Show available deploy targets
  plan <target>           Describe what \`up\` would do, changing nothing
  up <target>             Create or update the deployment
  down <target>           Tear it down
  status <target>         Report what is currently deployed
  help <target>           Target-specific help

Options:
  -c, --config <path>     Path to config.yaml (its directory becomes TAI_HOME)

Targets come from two places: TAI's built-ins, and the \`deployTargets\` export
of any plugin installed with \`tai plugin install\`. Discovery is by
installation, not configuration — a deploy target is usable before the instance
it deploys has a config.yaml.

Examples:
  tai deploy list
  tai deploy plan docker
  tai deploy up docker -- --force-recreate`;

/** Find the repo root by walking up for pnpm-workspace.yaml. Targets that
 * build from source need it; `undefined` is a fine answer for a global install
 * and the target decides whether it can proceed without one. */
function findRepoRoot(from: string): string | undefined {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function printPlanOrExit(target: DeployTarget, plan: Awaited<ReturnType<DeployTarget["plan"]>>): void {
  console.log(`\nPlan for \`${target.id}\`:\n`);
  for (const [i, step] of plan.steps.entries()) {
    const mark = step.consequential ? "!" : " ";
    console.log(` ${mark} ${i + 1}. ${step.title}`);
    if (step.command) console.log(`      $ ${step.command}`);
  }
  if (plan.notes?.length) {
    console.log(`\nNotes:`);
    for (const note of plan.notes) console.log(`  - ${note}`);
  }
  if (plan.problems?.length) {
    console.log(`\nProblems (\`up\` would fail):`);
    for (const problem of plan.problems) console.log(`  ✗ ${problem}`);
  }
  console.log();
}

export async function runDeployCommand(args: string[]): Promise<void> {
  // Split target-specific args at `--` before any parsing, so a target's own
  // flags can collide freely with TAI's without either side needing to know.
  const sep = args.indexOf("--");
  const targetArgs = sep === -1 ? [] : args.slice(sep + 1);
  const own = sep === -1 ? args : args.slice(0, sep);

  let configOverride: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (arg === "-c" || arg === "--config") {
      configOverride = own[++i];
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      return;
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0];
  // Bare `tai deploy`, and bare `tai deploy help`, both print the overview.
  // `tai deploy help <target>` falls through to the target's own help below.
  if (!command || (command === "help" && !positional[1])) {
    console.log(USAGE);
    return;
  }

  const homeDir = adoptHomeDir(configOverride);
  const { registry, problems } = await discoverDeployTargets(homeDir);

  if (command === "list") {
    const entries = registry.entriesList();
    console.log(`Available deploy targets:\n`);
    for (const [id, target] of entries) {
      console.log(`  ${id.padEnd(14)} ${target.description}`);
    }
    console.log(`\nRun \`tai deploy help <target>\` for target-specific options.`);
    console.log(`Install more with \`tai plugin install <package>\`.`);
    if (problems.length > 0) {
      // An installed plugin that contributes nothing usable must say so —
      // otherwise the operator sees their package installed and its target
      // simply absent, with nothing to search for.
      console.log(`\nSkipped while discovering targets:`);
      for (const p of problems) console.log(`  ! ${p.module}: ${p.reason}`);
    }
    return;
  }

  const targetId = positional[1];
  if (!targetId) {
    console.error(`\`tai deploy ${command}\` needs a target. Run \`tai deploy list\` to see them.`);
    process.exit(1);
  }

  const target = registry.get(targetId);
  if (!target) {
    console.error(`Unknown deploy target "${targetId}".`);
    console.error(`Available: ${registry.list().join(", ") || "(none)"}`);
    if (problems.length > 0) {
      console.error(`\nOne or more installed plugins failed to contribute targets:`);
      for (const p of problems) console.error(`  ! ${p.module}: ${p.reason}`);
    }
    process.exit(1);
  }

  const ctx: DeployContext = {
    homeDir,
    configPath: configOverride ? resolve(configOverride) : resolve(homeDir, "config.yaml"),
    repoRoot: findRepoRoot(process.cwd()),
    args: targetArgs,
    log: (message: string) => console.log(`  ${message}`),
  };

  switch (command) {
    case "help": {
      console.log(target.help ?? `${target.id} — ${target.description}\n\n(no extended help provided)`);
      return;
    }

    case "plan": {
      const plan = await target.plan(ctx);
      printPlanOrExit(target, plan);
      if (plan.problems?.length) process.exit(1);
      return;
    }

    case "up": {
      // Always plan first. A target reports its unmet preconditions there, and
      // starting work that is already known to fail wastes an image build and
      // buries the real cause under the resulting error.
      const plan = await target.plan(ctx);
      if (plan.problems?.length) {
        printPlanOrExit(target, plan);
        process.exit(1);
      }
      for (const note of plan.notes ?? []) console.log(`  note: ${note}`);
      const result = await target.up(ctx);
      console.log(result.ok ? `\n✓ ${result.summary}` : `\n✗ ${result.summary}`);
      if (result.url) console.log(`  ${result.url}`);
      for (const detail of result.details ?? []) console.log(`  ${detail}`);
      if (!result.ok) process.exit(1);
      return;
    }

    case "down": {
      if (!target.down) {
        console.error(`Target "${target.id}" does not support \`down\`.`);
        process.exit(1);
      }
      const result = await target.down(ctx);
      console.log(result.ok ? `✓ ${result.summary}` : `✗ ${result.summary}`);
      for (const detail of result.details ?? []) console.log(`  ${detail}`);
      if (!result.ok) process.exit(1);
      return;
    }

    case "status": {
      if (!target.status) {
        console.error(`Target "${target.id}" does not report status.`);
        process.exit(1);
      }
      const status = await target.status(ctx);
      console.log(`${target.id}: ${status.state}`);
      if (status.url) console.log(`  ${status.url}`);
      for (const detail of status.details ?? []) console.log(`  ${detail}`);
      return;
    }

    default:
      console.error(`Unknown command "${command}".\n`);
      console.log(USAGE);
      process.exit(1);
  }
}
