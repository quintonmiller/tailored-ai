# Running two TAI instances

How to run more than one TAI deployment on one machine — the intended case being a
personal instance and a work instance with separate Discord bots, only one running
at a time.

Status: **partly supported.** `TAI_HOME` is now honoured everywhere ([#311]), so
`-c <config>` selects a whole instance. The service script still has no instance
dimension ([#312]) and a double start still fails opaquely ([#313]). This doc
records what holds, what leaks, and what is left.

[#311]: https://github.com/quintonmiller/tailored-ai/issues/311
[#312]: https://github.com/quintonmiller/tailored-ai/issues/312
[#313]: https://github.com/quintonmiller/tailored-ai/issues/313

## The seam that already exists

`packages/cli/src/home.ts` resolves the home directory as:

```
-c <config path> dirname  >  $TAI_HOME  >  ~/.tailored-ai
```

Everything derived from `homeDir` is genuinely per-instance today:

| what | where |
|---|---|
| `config.yaml`, `.env` | `<home>/` |
| `agent.db` | `<home>/agent.db` (`database.path`, relative) |
| context, KB, projects | `<home>/data/` |
| installed plugins | `<home>/plugins/` (`PluginManager`) |
| Discord token | per-home `config.yaml` / `.env` |

That is most of the state, and it is clean.

## What used to leak, and how it was closed

Nine modules answered "where is home?" for themselves and did not agree. Five read
`TAI_HOME` — which nothing in the repo ever assigned, so all five took their
fallback branch on every run. Four ignored it outright and resolved against
`homedir()` or `$HOME`. `tai -c <other home>` therefore got its own config and
database while writing its keys and cached output into the default home. The
giveaway on a real install was `~/.tai/exec-outputs` accumulating hundreds of
session directories, a path no config mentions.

All nine now derive from one function, `taiHome()` in `packages/core/src/home.ts`,
and `packages/cli/src/home.ts` `adoptHomeDir()` publishes the resolved home as
`TAI_HOME` at every entry point. That assignment is what makes `-c` and the
environment variable the same instruction.

Two properties are load-bearing and easy to undo by accident:

- **The environment is read on every call, never at module load.** `import` runs
  every module body before `main()` parses `-c`, so anything that caches the
  answer in a top-level `const` captures the value from before the CLI publishes
  it. `tools/sandbox-boundary.ts` did exactly that, which would have left the
  scratch allowlist naming a directory nothing writes to on any instance started
  with `-c` — the fix present in the source and absent at runtime.
- **The legacy `~/.tai` scratch stays readable.** Truncated tool and exec results
  hand the model an absolute path to the full text, and those pointers live in
  session history indefinitely. Nothing writes there now, but a boundaried agent
  re-reading a month-old pointer must not be refused because the write location
  moved.

Scratch output consequently moves from `~/.tai/{exec,tool}-outputs` to
`<home>/{exec,tool}-outputs`. Existing files stay where they are; nothing reads
them except on demand.

### Still shared: `tai.lock` resolves against `cwd`

`resources/lockfile.ts` `defaultLockfilePath()` uses `process.cwd()`, and the server
calls it with no argument. Both instances launched from the same checkout share one
lockfile.

Left alone deliberately. Whether `tai.lock` is repo-scoped (like `package-lock.json`,
which is what the cwd default implies and what the CLI's `--lockfile` flag reads as)
or instance-scoped is a design question, and the answer differs between the
interactive CLI and a long-running server that has no meaningful cwd. No deployment
has a `tai.lock` yet, so nothing is broken today; deciding it inside a "honour
`TAI_HOME`" change would have been a silent semantic switch.

## The service script

`scripts/tai-ctl.sh` has no instance dimension:

- `RUN_DIR=$HOME/.tai/run` and `LOG_DIR=$HOME/.tai/logs` are fixed, so two instances
  share `agent.pid` and `agent.log`. `stop` kills whichever process the file names,
  `status` reports the wrong one, logs interleave with no marker.
- `start_agent` runs `pnpm run dev` with **no `TAI_HOME` and no `-c`**. Instance
  identity is inherited ambiently from the invoking shell, so a bare `tai-ctl start`
  always boots the default home regardless of intent.
- `resolve_targets` maps `default` to `vllm agent`, so switching instances reloads a
  27B model for no reason. vLLM has nothing to do with which instance is running.

### Recommended shape

```
tai-ctl.sh start work|personal [targets]
tai-ctl.sh switch work
```

- Instance is a **required positional**, never inherited from the environment.
- Spawn with `env -i … TAI_HOME=$home` — `TAI_HOME` rather than `-c`, because core
  reads the env var directly and nothing sets it; a scrubbed env also stops a
  shell-exported `DISCORD_TOKEN` reaching the wrong home (`dotenv` does not override
  values already in `process.env`).
- Namespace run and log dirs by instance.
- Enforce exclusivity with the pid file plus a sibling `agent.instance` naming its
  owner. `start work` while that says `personal` refuses and says so. This is the
  accidental guard that already exists at `is_running agent`, made honest: pid
  liveness is the truth, so there is nothing stale to clean up after a crash.
- Drop `vllm` from the default targets and manage it as a peer service.

## Ports

**Keep both instances on 3000.** One-at-a-time makes sharing free; agent prompts in a
real deployment hardcode `localhost:3000` in many places; and the port acts as a
second, kernel-level lock. Distinct ports would make an accidental double-start
*succeed*, which is the outcome to avoid.

For that to be safe, two repo fixes are needed:

1. `serve()` registers no `error` listener, so `EADDRINUSE` surfaces as an unhandled
   event and the second instance dies on a raw stack trace that never names the
   cause.
2. The Discord gateway login, cron and autopilot all start *before* the HTTP bind, so
   a doomed second start logs a second bot in and fires cron for several seconds
   before the port collision kills it. Bind first.

## Discord

One bot token supports a single gateway identify, so a second instance needs its own
Discord application — new token, new client id, and realistically its own guild.
Channel ids cannot move between guilds, so rooms recreated elsewhere start with no
Discord-side history.

`getDiscordConfig` reads everything off `runtime.getConfig()` per call and
`DiscordChannel` owns its own client, so two processes with two tokens are cleanly
separate identities. Cross-posting is structurally impossible.

One guardrail worth arming: `shouldRespond` only filters by guild when
`allowedGuilds` is non-empty. With `respondToMentions: true` and no `allowedGuilds`,
two bots that ever end up in the same guild both answer the same mention. Set
`allowedGuilds` in both configs.

## What to share, what to duplicate

| shareable | why |
|---|---|
| vLLM endpoint | Stateless inference addressed purely by config; batches concurrent requests |
| embedding endpoint | Same |
| the repo checkout | Workflows live here and are shared by path |

| duplicate | why |
|---|---|
| `config.yaml`, `.env`, `agent.db`, `data/` | Per-instance by definition |
| plugin home | `PluginManager` derives `<home>/plugins`; symlinking works (load is read-only) but couples both instances to one `tai plugin` operation |

Anything holding a single external identity needs a decision rather than a copy — a
mailbox credential given to both instances means both poll the same inbox and
double-process it.

## Starting a second instance fresh

The lower-risk path when an existing deployment is large: leave it as-is and build
the new instance empty, moving items over deliberately.

Copy-then-delete looks safer and is not. In a mature deployment most message history
has no agent attribution — sessions carry a `key` string convention but no agent
column — so there is no reliable filter for what to remove. Every missed deletion is
a silent leak of the other side's history; every wrong one is unrecoverable. Building
empty makes each mistake an *omission*, fixable later by copying one more thing.

Two hazards when moving data:

- **Never copy a live database.** With WAL enabled a plain `cp` of a running
  deployment yields a torn, stale file. Use `sqlite3 agent.db "VACUUM INTO 'x.db'"`
  or stop the agent first.
- **`project_id` is not the scoping seam it appears to be.** Several tables carry the
  column but leave it null in practice, so a plan that filters on it can silently
  move almost nothing. Check the actual distribution before relying on it.

## `TAI_HOME` is not a security boundary

Both instances run as the same unix user with `exec`, `read` and `write` and no
filesystem sandbox by default. A work agent can read the personal `agent.db` and
`.env` with a single tool call. Instance separation is organizational; for real
containment, use separate unix users or a sandbox.
