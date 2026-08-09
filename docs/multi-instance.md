# Running two TAI instances

How to run more than one TAI deployment on one machine. The usual reason is to keep
two contexts apart — separate Discord bots, separate databases, separate agents —
with only one running at a time. The examples below use `personal` and `work` as
instance names; they are yours to choose.

Status: **supported, not yet widely exercised.** `TAI_HOME` is honoured everywhere
([#311]) so `-c <config>` selects a whole instance, and `tai-ctl.sh` takes an
instance on every command ([#312]). A double start still fails opaquely ([#313]).
This doc records what holds, what leaks, and what is left.

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

`scripts/tai-ctl.sh` takes an instance:

```
tai-ctl.sh start   -i personal [agent|ui|vllm|all] [--no-build]
tai-ctl.sh restart -i personal agent
tai-ctl.sh switch  -i work            # stop the others, start this one
tai-ctl.sh status                     # every instance; -i narrows it
tai-ctl.sh instances                  # what's declared, and who holds the agent slot
```

Instances are declared in `~/.tai/instances.conf` as `name=/path/to/home`, one per
line. The file is created on first run holding the single instance that already
exists.

Per-machine settings go in `~/.tai/env`, sourced before `tai-ctl`'s own defaults
if the file exists. Write entries as `VAR="${VAR:-value}"` so a one-off
`VAR=... tai-ctl ...` still outranks the file. This is where `VLLM_SCRIPT` belongs
on a box that fronts vLLM with a router: the built-in default starts a single
model server directly, so without the pin a plain `tai-ctl restart vllm` quietly
swaps a multi-model setup for a one-model one. A shell rc cannot do this job —
it reaches interactive shells, not cron or a detached service.

`-i` is required by every command that touches `agent` or `ui`. With two homes
sharing one port and one machine, an unqualified `restart` is a coin flip, and
getting it wrong means the work bot answering personal messages. `vllm` needs no
instance — one model server serves all of them — so its pid and log stay outside
the per-instance directories, and it is no longer in the default target set:
switching instances has nothing to do with the model server, and reloading a 27B
model to restart an agent costs minutes for nothing.

Three details worth keeping if you touch it:

- **The agent is spawned with a scrubbed environment** (`env -i`) carrying an
  explicit `TAI_HOME`. The scrub matters more than the assignment: `dotenv` does
  not overwrite a variable already present in the environment, so a
  `DISCORD_TOKEN` exported in the invoking shell outranks the instance's own
  `.env`, and the wrong bot logs in with no error anywhere.
- **Exclusivity is enforced by scanning every instance's pid file for a live
  process**, not by a stored owner marker. Pid liveness is the only truth, so a
  crashed instance releases the slot with nothing stale to clean up.
- **The old flat layout is adopted on first run.** `agent.pid` and `agent.log`
  used to sit directly in `~/.tai/{run,logs}`; an agent started under the previous
  script would otherwise be invisible to `stop` — reported as "not running" while
  it went on holding port 3000.

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

## Switching from Discord

A plugin can register `/instance` to report which deployment is running and switch
between them, using the slash-command seam described in
[architecture.md](./architecture.md#plugin-slash-commands). It is deployment-specific —
it shells out to `tai-ctl.sh` and reads `~/.tai/instances.conf` — so it belongs in the
plugin home, not this repo.

Worth writing down because the obvious implementation cannot work: **the switch kills
the process serving the command.** `tai-ctl.sh switch` stops the running agent, and the
plugin is running inside that agent. Two things make it survivable:

- **Run the switch fully detached.** `spawn(..., { detached: true })` puts the child in
  a new session via `setsid`, so `kill -- -PID` on the agent's process group does not
  reach it. stdio must go to a file rather than inherited pipes, which would keep the
  child tethered to the dying parent, and `unref()` lets the parent exit without waiting.
- **Make the child sleep first.** Discord needs the interaction reply to land before the
  process disappears. Reply, then switch a few seconds later.

Get either wrong and the symptom is identical: Discord shows "the application did not
respond", and nothing is running afterwards. The detachment is worth testing directly —
send `SIGTERM` to the parent's whole process group and check the child still runs.

Restrict the command to the configured `channels.discord.owner`. Everyone in the guild
can see a registered command, and without the check any of them could stop the agent the
others are talking to.
