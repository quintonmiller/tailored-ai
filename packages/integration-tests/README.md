# @tailored-ai/integration-tests

Docker-based end-to-end tests for the `tai` CLI. Closes the gap between
"unit tests pass" and "a clean install actually works." Tracks [#45].

## What it does

1. Builds every workspace package and `pnpm pack`s the runtime ones (`core`,
   `server`, `cli`, plus their workspace deps) into tarballs.
2. Starts a clean `node:20-bookworm-slim` stage that has never seen the
   repo, installs the tarballs globally with `npm`, and verifies `tai
   --help` works.
3. Inside the container, starts a deterministic OpenAI-compatible mock
   provider so the agent loop has something to talk to without reaching the
   real network.
4. Seeds `TAI_HOME=/work/.tai` with a known config and runs each script in
   `scenarios/` against the installed CLI.

Anything that silently relied on workspace layout (sibling `node_modules`,
`tsconfig` paths, env vars set by `pnpm dev`) fails here, which is exactly
the failure we want to catch before a release.

## Running

From the repo root:

```sh
pnpm --filter @tailored-ai/integration-tests run test:e2e
```

Other entry points:

```sh
# rebuild image without running anything
pnpm --filter @tailored-ai/integration-tests run test:e2e:build

# drop into a shell inside the runtime image (mock provider is NOT started)
pnpm --filter @tailored-ai/integration-tests run test:e2e:shell

# run a single scenario by name
bash packages/integration-tests/scripts/run.sh 03-basic-chat
```

The image tag defaults to `tai-e2e:local`; override with `TAI_E2E_IMAGE`.

## Layout

```
Dockerfile               two-stage build → packed-tarball install
Dockerfile.dockerignore  context allowlist for the docker build
docker/entrypoint.sh     in-container runner: boots mock, runs scenarios
fixtures/config.yaml     known-good config wired to the mock provider
fixtures/mock-provider.mjs  deterministic /v1/chat/completions server
scenarios/*.sh           one bash script per assertion. Numbered for order.
scripts/run.sh           host-side wrapper around docker build/run
```

## Adding a scenario

Drop a `NN-name.sh` into `scenarios/`. The harness runs every `*.sh` in
alphabetical order. Each script can assume:

- `tai` is on PATH (installed globally from the workspace tarballs)
- `TAI_HOME=/work/.tai` is pre-seeded with `fixtures/config.yaml`
- The mock provider is reachable at `http://127.0.0.1:18080/v1`
- Its log is at `$MOCK_PROVIDER_LOG` (JSONL, one event per request)

Failures: `set -euo pipefail` + exit non-zero. The runner aggregates passes
and fails and exits non-zero if any scenario fails.

If you need a new canned model response, add it to the `RESPONSES` array in
`fixtures/mock-provider.mjs` — keyed by a regex against the last user
message.

## Current coverage

| # | scenario | what it asserts |
|---|---|---|
| 01 | `tai --help` | bin entry resolves, no import-time crash |
| 02 | `tai --list-agents` | config loader + agent merge surface the fixture agent |
| 03 | `tai -m "ping"` | full agent loop round-trips through the mock provider |
| 04 | `tai plugin install/list/remove` | plugin home bootstrap, install from local path, list, remove |
| 05 | `tai` (server mode) | server boots, `/api/health` + `/api/agents` respond, SIGTERM shuts down cleanly |
| 06 | `tai project init/list` | SQLite project store + project subcommand router |

CI runs the suite on every PR via `.github/workflows/e2e.yml`.

## Known limitations

- **Plugin runtime registration isn't covered.** A plugin installed via
  `tai plugin install` lives at `<TAI_HOME>/plugins/node_modules/<plugin>/`.
  From there, standard Node ESM resolution can't find the
  globally-installed `@tailored-ai/core`, so a plugin that imports core
  to call `registerToolFactory()` will fail to load. Scenario 04 covers
  install/list/remove mechanics only; runtime registration needs either
  a `NODE_PATH` shim or a change to `PluginManager.buildImporter` to
  forward the CLI's resolution context. Tracked separately — file an
  issue if this hits you in real use.

## What's not covered yet

- a real plugin that registers a tool factory at runtime (see above)
- multi-project routing (`--project` resolution, per-project sessions)
- channel handshakes beyond HTTP (Discord, Slack — both need credentials
  the harness shouldn't carry)
- the Ink editor / TUI (would need expect-style scripting)

[#45]: https://github.com/quintonmiller/tailored-ai/issues/45
