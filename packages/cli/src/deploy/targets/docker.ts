/**
 * Built-in `docker` deploy target — runs TAI in a container on this machine
 * using the compose unit in `docker/tai/`.
 *
 * It exists as much to prove the seam as to be useful: a registry whose only
 * implementations live in unreleased plugin packages has never been shown to
 * work. Everything a cloud target needs to do — preflight, plan, shell out,
 * report a URL — this target does, so its shape is the worked example a plugin
 * author copies.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployContext, DeployPlan, DeployResult, DeployStatus, DeployTarget } from "@tailored-ai/core";

const COMPOSE_PROJECT = "tai";

/** Run a command, capturing output. Never throws — every caller wants to
 * report the failure rather than unwind through it. */
function run(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): { ok: boolean; stdout: string; stderr: string; missing: boolean } {
  const res = spawnSync(command, args, { cwd: opts.cwd, encoding: "utf-8" });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
    // ENOENT means the binary is not installed, which deserves a different
    // message than "the command ran and failed".
    missing: (res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
  };
}

/**
 * Find `docker/tai/` — the compose unit and Dockerfile.
 *
 * This target only works from a source checkout: it builds the image from the
 * workspace, and the published npm package ships compiled JS, not the
 * Dockerfile or the packages it needs as build context. Saying so precisely
 * beats a confusing "file not found" three steps later.
 */
function findComposeDir(ctx: DeployContext): string | null {
  const candidates: string[] = [];
  if (ctx.repoRoot) candidates.push(resolve(ctx.repoRoot, "docker", "tai"));
  candidates.push(resolve(process.cwd(), "docker", "tai"));
  // dist/deploy/targets/docker.js -> up to the repo root in a dev checkout.
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(here, "..", "..", "..", "..", "..", "docker", "tai"));
  for (const dir of candidates) {
    if (existsSync(resolve(dir, "docker-compose.yml"))) return dir;
  }
  return null;
}

function composeArgs(dir: string, rest: string[]): string[] {
  return ["compose", "-p", COMPOSE_PROJECT, "-f", resolve(dir, "docker-compose.yml"), ...rest];
}

function preflight(ctx: DeployContext): { problems: string[]; notes: string[]; composeDir: string | null } {
  const problems: string[] = [];
  const notes: string[] = [];

  const docker = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (docker.missing) {
    problems.push("`docker` is not on PATH. Install Docker Engine or Docker Desktop.");
  } else if (!docker.ok) {
    problems.push(
      "`docker version` failed — the daemon is not reachable. Start Docker, or add your user to the `docker` group.",
    );
  } else {
    notes.push(`Docker Engine ${docker.stdout}`);
  }

  const compose = run("docker", ["compose", "version", "--short"]);
  if (docker.ok && !compose.ok) {
    problems.push("`docker compose` is unavailable — this target needs Compose v2, not the legacy docker-compose.");
  }

  const composeDir = findComposeDir(ctx);
  if (!composeDir) {
    problems.push(
      "Could not find docker/tai/docker-compose.yml. This target builds the image from the workspace, " +
        "so it needs a source checkout — run it from a clone of the repo, not from a global npm install.",
    );
  } else if (!existsSync(resolve(composeDir, ".env"))) {
    // Not fatal: TAI_MODEL can come from the ambient environment instead.
    notes.push(
      `No ${resolve(composeDir, ".env")} — copy .env.example and set TAI_MODEL, ` +
        `or export it before running (the container refuses to guess a model).`,
    );
  }

  return { problems, notes, composeDir };
}

export const dockerTarget: DeployTarget = {
  id: "docker",
  description: "Run TAI in a container on this machine (docker compose, one volume).",
  help: `tai deploy up docker

Builds the image from docker/tai/Dockerfile and starts one container with a
named volume at TAI_HOME. Requires a source checkout — the published npm
package does not ship the Dockerfile or the workspace it builds from.

Configuration is docker/tai/.env (copy .env.example). TAI_MODEL is required.

Arguments after \`--\` are passed to \`docker compose up\`, e.g.
  tai deploy up docker -- --build --force-recreate`,

  async plan(ctx: DeployContext): Promise<DeployPlan> {
    const { problems, notes, composeDir } = preflight(ctx);
    const dir = composeDir ?? "<docker/tai>";
    return {
      problems,
      notes,
      steps: [
        { title: "build the tai image from the workspace", command: `docker ${composeArgs(dir, ["build"]).join(" ")}` },
        {
          title: "start one container with a named volume at TAI_HOME",
          command: `docker ${composeArgs(dir, ["up", "-d"]).join(" ")}`,
          consequential: true,
        },
        { title: "first boot writes config.yaml and prints a generated API token" },
      ],
    };
  },

  async up(ctx: DeployContext): Promise<DeployResult> {
    const { problems, composeDir } = preflight(ctx);
    if (problems.length > 0 || !composeDir) {
      return { ok: false, summary: "preflight failed", details: problems };
    }

    ctx.log("Building image…");
    const build = run("docker", composeArgs(composeDir, ["build"]), { cwd: composeDir });
    if (!build.ok) {
      return { ok: false, summary: "image build failed", details: [build.stderr || build.stdout] };
    }

    ctx.log("Starting container…");
    const up = run("docker", composeArgs(composeDir, ["up", "-d", ...ctx.args]), { cwd: composeDir });
    if (!up.ok) {
      return { ok: false, summary: "`docker compose up` failed", details: [up.stderr || up.stdout] };
    }

    const port = run("docker", composeArgs(composeDir, ["port", "tai", "3000"]), { cwd: composeDir });
    const url = port.ok && port.stdout ? `http://${port.stdout.split("\n")[0]}` : undefined;

    return {
      ok: true,
      summary: "TAI is running",
      url,
      details: [
        "First boot generates an API token and prints it once:",
        `  docker ${composeArgs(composeDir, ["logs", "tai"]).join(" ")}`,
        "Before exposing this beyond loopback, read docs/self-hosting.md — the",
        "bundled dashboard cannot send an API token yet.",
      ],
    };
  },

  async down(ctx: DeployContext): Promise<DeployResult> {
    const { composeDir } = preflight(ctx);
    if (!composeDir) return { ok: false, summary: "could not find docker/tai/docker-compose.yml" };

    // Stop the container, keep the volume. Deleting the instance's database,
    // config, and installed plugins is not something to infer from "down" —
    // `docker volume rm tai_tai-data` is one command away and is the
    // operator's to run knowingly.
    const res = run("docker", composeArgs(composeDir, ["down"]), { cwd: composeDir });
    if (!res.ok) return { ok: false, summary: "`docker compose down` failed", details: [res.stderr] };
    return {
      ok: true,
      summary: "container stopped; the tai-data volume was kept",
      details: ["Delete the state too with: docker volume rm tai_tai-data"],
    };
  },

  async status(ctx: DeployContext): Promise<DeployStatus> {
    const { composeDir } = preflight(ctx);
    if (!composeDir) return { state: "unknown", details: ["could not find docker/tai/docker-compose.yml"] };

    const ps = run("docker", composeArgs(composeDir, ["ps", "--format", "{{.Name}}\t{{.State}}\t{{.Status}}"]), {
      cwd: composeDir,
    });
    if (!ps.ok) return { state: "unknown", details: [ps.stderr] };
    if (!ps.stdout) return { state: "not deployed" };

    const [, state, statusText] = ps.stdout.split("\n")[0].split("\t");
    const port = run("docker", composeArgs(composeDir, ["port", "tai", "3000"]), { cwd: composeDir });
    return {
      state: state ?? "unknown",
      url: port.ok && port.stdout ? `http://${port.stdout.split("\n")[0]}` : undefined,
      details: statusText ? [statusText] : undefined,
    };
  },
};
