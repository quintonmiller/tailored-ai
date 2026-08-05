# Deploy targets

`tai deploy` puts an instance somewhere. TAI ships one target — `docker`, which
runs a container on the local machine — and everything else (AWS, GCP, Fly,
Hetzner, your company's internal platform) is a plugin.

```bash
tai deploy list
tai deploy plan docker         # describe what `up` would do, change nothing
tai deploy up docker
tai deploy status docker
tai deploy down docker
tai deploy help docker
tai deploy up docker -- --force-recreate    # args after `--` go to the target
```

## Where the pieces live

| Piece | Package | Why |
|---|---|---|
| `DeployTarget` and friends | `@tailored-ai/core` (types only) | The package every plugin already depends on. The import erases at compile time, so the runtime cost is nil. |
| Registry, discovery, `tai deploy` | `@tailored-ai/cli` | Deployment is a CLI-time concern. The agent runtime never needs to know how it was deployed, so an implementation in the runtime library would be weight every embedder pays for and nobody uses. |
| `docker` target | `@tailored-ai/cli` | A reference implementation, so the seam is exercised rather than assumed. |

## Writing one

A deploy plugin exports a `deployTargets` array. That is the whole contract.

```ts
import type { DeployTarget } from "@tailored-ai/core";

const flyTarget: DeployTarget = {
  id: "fly",
  description: "Deploy TAI to a Fly.io machine with a persistent volume.",
  help: "tai deploy up fly\n\nNeeds flyctl on PATH and `fly auth login`.",

  async plan(ctx) {
    const problems: string[] = [];
    if (!hasFlyctl()) problems.push("`flyctl` is not on PATH.");
    return {
      problems,
      steps: [
        { title: "create the app and a 10GB volume", consequential: true },
        { title: "set secrets from the local .env" },
        { title: "deploy the image" },
      ],
    };
  },

  async up(ctx) {
    ctx.log("Creating volume…");
    // …
    return { ok: true, summary: "deployed", url: "https://my-tai.fly.dev" };
  },

  async down(ctx) { /* … */ },
  async status(ctx) { /* … */ },
};

export const deployTargets: DeployTarget[] = [flyTarget];
```

Install it and the target appears:

```bash
tai plugin install @acme/tai-deploy-fly
tai deploy list
```

### The rules that matter

**`plan` must not change anything.** It is what an operator runs to decide
whether to trust your target. Put every precondition you check — missing
binary, absent credential, bound port — into `problems`. `tai deploy up` calls
`plan` first and refuses to start when `problems` is non-empty, so a good plan
turns a half-finished deployment into a clean refusal.

**Mark `consequential` steps.** Anything that costs money, touches a remote
account, or is hard to undo. The CLI flags those with `!` so a plan stays
skimmable for the parts that matter.

**Return a `url` from `up` when there is one.** It is the first thing the
operator wants.

**Be conservative in `down`.** The built-in `docker` target stops the container
and *keeps* the volume, telling the operator the one command that would delete
it. Destroying an instance's database, config, and installed plugins should not
be something a person infers from the word "down".

**Use `ctx.log`, not `console.log`,** so output stays consistent with the rest
of the command.

## Discovery: by installation, not configuration

Every other extension point registers through `PluginContext` during
`loadPlugins`, which needs a loaded `config.yaml`. Deploy targets cannot work
that way: `tai deploy` is frequently the command that *creates* the instance a
config would describe, so it must enumerate targets before any config exists.

So the CLI enumerates packages installed in `<TAI_HOME>/plugins/`, imports each,
and reads the `deployTargets` named export — the same shape the plugin loader
already uses for the optional `meta` and `validateConfig` exports. Nothing needs
to be listed in `plugins:` for a deploy target to be available.

Consequences worth knowing:

- Your module is imported by `tai deploy`, so **keep top-level side effects
  out of it**. Do the work inside `plan`/`up`.
- A plugin that fails to import is reported by `tai deploy list` and skipped;
  one broken package does not make the command unusable.
- Registering an existing id overrides it. That is allowed — replacing the
  built-in `docker` target is legitimate — and the override is reported, since
  "my target stopped working" is otherwise an unsearchable symptom.

## What a cloud target should target

A single VM with a persistent disk. TAI's state is SQLite, which takes one
writer, so there is no replica set to manage: EC2 or Lightsail, Compute Engine,
a Droplet, a Hetzner box.

Serverless container platforms (Fargate, Cloud Run, App Runner) are a poor fit
and a target for one should say so rather than paper over it. They assume a
stateless replaceable container; SQLite on a network filesystem (EFS,
Filestore) breaks WAL locking, and scale-to-zero stops cron and autopilot,
which is most of what a personal agent does when nobody is looking at it.

See [self-hosting.md](./self-hosting.md) for the deployment shape itself, and
the exposure/auth options a target should wire up.
