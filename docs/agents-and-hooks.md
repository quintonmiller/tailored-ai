# Agents, Hooks, Cron & Prompt Expansion

How named agents, delegation, hook pipelines, cron jobs, and prompt templating all fit together.

## Agents & Delegation

Agents are named configurations defined in `config.yaml` under `agents:`. They can override model, description, instructions, tools (allowlist), temperature, maxTokens, maxToolRounds, and hooks.

### `maxTokens`

Caps what the model may generate per call. Resolution is
`agents.<name>.maxTokens` → `agent.maxTokens` → omitted, and omitted is the
default: sending an invented number would cap generation on every deployment
that never asked for one.

Set it on any metered provider. Some reserve the model's whole output window
against your balance for the length of a request when the field is absent —
OpenRouter reserves 65536 tokens per call and answers 402 once the balance stops
covering that reservation, even when the reply itself would have cost cents. It
reads as a provider refusing every request while the account is in credit.

```yaml
agent:
  maxTokens: 4096          # deployment-wide default
agents:
  writer:
    maxTokens: 16384       # this one needs room
```

### `exec` — per-agent command rules

The deployment allowlist is one list on one shared `ExecTool` instance, so
granting an agent `exec` grants it everything on that list. `agents.<name>.exec`
takes the same `allow` / `deny` shape as `tools.exec` and narrows it for that
agent alone, which is what makes `exec` safe to hand out for one purpose:

```yaml
tools:
  exec:
    allow: [git, ls, ntn]
    deny: [rm]
    mode: intersect        # default; `override` lets an agent replace these
agents:
  researcher:
    tools: [exec, web_search]
    exec:
      allow: [ntn]         # this agent gets ntn and nothing else
```

Both lists accept glob patterns (`*`, `?`), matched against the command name in
**every** command position — so `ntn api x && rm -rf /` is rejected on the
second segment. `deny` always wins over `allow`, at both levels.

Three properties worth knowing:

- **`mode` is deployment-level only.** An agent that could choose `override` for
  itself would make `intersect` guarantee nothing.
- **Under `intersect` an agent can only narrow.** An allow list that intersects
  to nothing denies everything rather than reverting to unrestricted — the
  opposite would fail open.
- **This scopes the `exec` tool, not the agent.** `custom_tools` run their own
  fixed command and never consult these rules, so `exec: {allow: [ntn]}` means
  "this agent's exec tool can only run ntn", not "this agent can only run ntn".

Rules travel with `resolveAgent` → `buildLoopOptions` → `ToolContext.execRules`,
the same path as `fileBoundary`. Delegated sub-agents inherit them, because
`DelegateTool` builds its loop options from the runtime.

- `packages/core/src/agent/agents.ts` — `resolveAgent()` merges a named agent with agent defaults
- `packages/core/src/tools/delegate.ts` — `DelegateTool` lets the agent spawn a sub-agent with a specific agent config
- Sub-agents are depth-1 only (they don't get the delegate tool)
- Each delegation creates an ephemeral session keyed `delegate:<parentSessionId>:<uuid>`

### Knowing how a delegation went

**Synchronous** (`async` omitted or false) blocks and returns the sub-agent's
answer. A sub-agent that ran out of tool rounds, or looped on the same call, is
reported as a **failure** — `success: false` with the reason and the partial
output. It used to come back as a successful call whose text happened to be
`[Agent stopped: …]`, which the caller could not distinguish from an answer;
observed live, an EA silently retried instead of reporting the problem.

**Asynchronous** (`async: true`) returns a task id immediately and runs the
sub-agent in the background.

| | you get | you find out by |
|---|---|---|
| `async: true` | task id | calling `task_status(taskId: …)` yourself |
| `async: true, notify: true` | task id | being sent the result when it finishes |

`notify: false` is the default: a clean hand-off where you hear nothing back.
`notify: true` delivers the outcome — success *or* failure — into your own
session through the same path as `room(action="dm")`, attributed to the agent
that did the work.

Two limits worth knowing, both from the in-memory task registry
(`agent/tasks.ts`):

- **Results are dropped after an hour**, and eviction is lazy — it runs when the
  next background task starts, so a burst of delegations can sweep an unread
  result early. Observed live: a result sat unread for 51 minutes, 9 minutes
  from being evicted, because the delegating agent had no way to know it was
  ready.
- **Nothing survives a restart.** In-flight and completed background tasks are
  gone with no notice to whoever delegated them.

So an agent that delegates without `notify` and then tells someone "I'll follow
up" is promising something it cannot do. The tool result says as much.

**CLI usage:**
```bash
pnpm run dev -- -a researcher -m "Find AI news"   # use a named agent
pnpm run dev -- --list-agents                      # show all agents
pnpm run dev -- --list-sessions                    # show 20 most recent sessions
```

**Config example:**
```yaml
agents:
  researcher:
    description: "Research assistant for web search and summarization"
    instructions: "You are a research assistant."
    tools: ["web_search", "web_fetch", "memory"]
    temperature: 0.5
    maxToolRounds: 5
  coder:
    model: "qwen3-coder:30b"
    instructions: "You are a code assistant."
    tools: ["exec", "read", "write", "memory"]
    maxToolRounds: 15
    hooks:
      afterRun:
        - tool: memory
          args: { action: "append", file: "work-log.md", content: "{{response}}" }

cron:
  jobs:
    - name: "daily-research"
      schedule: "0 9 * * *"
      prompt: "Research today's AI news"
      agent: "researcher"
```

### `/clone-agent` — copy a configuration, and nothing else

```
/clone-agent from:iris to:juno
```

Writes a copy of `iris`'s definition under `agents.juno` in `config.yaml` and reports both halves of what it did: the fields it carried over, one line each, and the things it deliberately left behind.

Nothing else travels. **Core memory, sessions, notes and room subscriptions are all keyed by agent name and stay with the original** — `juno` starts with an empty persona, no history, and membership in no room, so nothing can wake it until you add it to one. That is the reason the command exists: done by hand this was one copy and three checks, and the interesting failure was always the silent one — a "fresh" clone that inherited the original's persona, or that woke up in its rooms and answered as if it had been there all along.

Three things about the implementation (`packages/core/src/channels/discord-clone-agent.ts`) are load-bearing:

- **The source is read registry-first**, the same precedence [`resolveAgent`](#agents--delegation) uses. An agent that has been migrated to `data/authored-resources/agent/<id>/manifest.yaml` still has its old block sitting in `config.yaml`; reading that block would clone what the agent used to be, wrong in fields that still parse. The reply says which one it read.
- **The write goes through `updateRawConfig`** (`packages/core/src/config-write.ts`), so a clone that would introduce config that parses but is never read is refused with the file untouched, and the reasons come back in the reply.
- **Every refusal happens before the write** — unknown source, a target name outside `[A-Za-z0-9_-]+`, or a target that already exists in either the registry or `config.yaml`.

It is a top-level command rather than a subcommand of `/agent`, because `/agent` already carries a required top-level option and Discord forbids a command that has both options and subcommands.

**No restart is needed.** `updateRawConfig` reloads the runtime and `resolveAgent` falls back to `config.agents`, so the clone answers immediately. The agent registry is only populated from disk in the `AgentRuntime` constructor, so the clone lives in `config.yaml` until the next restart migrates it into its own manifest — which changes nothing about whether it resolves.

### Task-watcher fields: `worktree` and `taskPreamble`

Two agent fields shape how the task watcher dispatches to a named agent. Both are off/empty by default, so core ships no built-in coding workflow (#204) — you opt your own agents in.

- `worktree: true` — task-watcher dispatches to this agent run in an isolated git worktree on a per-task branch (`agent/<task_id>-<slug>`). The watcher creates the worktree before the loop, sets it as the working-directory boundary, and cleans it up after (keeping the branch so later iterations reuse it). The default `builtin:coder-project-guard` plugin refuses a worktree-opted dispatch that lacks a project whose `path` is a git repo, and `builtin:scope-creep-flagger` watches worktree-opted agents for cross-task commits.
- `taskPreamble:` — a prompt template prepended to the task-watcher dispatch prompt for this agent. It runs through the normal `{{var}}` expansion (see Prompt Expansion below) with these vars: `task_id`, `task_title`, `task_status`, `task_description`, `task_author`, `task_tags`, `action`, `project_id`, `owner_name`, plus `worktree_path` and `worktree_branch` (empty strings when the agent has no worktree). This is where install-specific role guidance lives — coder lifecycle, reviewer gates, handoff conventions — instead of being hardcoded in core.

```yaml
agents:
  coder:
    worktree: true
    taskPreamble: |
      You are the coder. A git worktree is checked out at {{worktree_path}}
      on branch {{worktree_branch}}. Make the minimal change for task
      {{task_id}}, run typecheck + tests, commit, then hand off to the
      reviewer.
  reviewer:
    worktree: true
    taskPreamble: |
      You are the reviewer for branch {{worktree_branch}}. Run the build/test
      gate before deciding; approve back to {{owner_name}} or request changes.
```

## Hooks

Hooks run tool calls before and/or after the agent loop. They are a first-class feature of agents and work across all entry points: CLI, Discord, HTTP API, webhooks, cron, and delegate.

### Configuration

Hooks can be defined at two levels:

1. **Agent-level** — in `agents.<name>.hooks` (runs everywhere the agent is used)
2. **Cron job-level** — in `cron.jobs[].hooks` (runs only for that cron job)

When both are present, agent hooks run first, then cron job hooks are appended.

```yaml
agents:
  researcher:
    instructions: "You are a research assistant."
    tools: ["web_search", "web_fetch", "memory"]
    hooks:
      beforeRun:
        - tool: memory
          args: { action: "read", file: "research-context.md" }
      afterRun:
        - tool: memory
          args: { action: "append", file: "research-log.md", content: "{{response}}" }

cron:
  jobs:
    - name: "daily-research"
      schedule: "0 9 * * *"
      prompt: "Research today's AI news"
      agent: "researcher"
      hooks:
        beforeRun:
          - tool: gmail
            args: { action: "check", query: "newer_than:1d" }
            skipIf: "no new messages"
```

### Hook shape (`AgentHook`)

```yaml
tool: "tool_name"            # required — name of any registered tool
args:                        # optional — arguments passed to the tool
  key: "value"               # string values support {{template}} interpolation
skipIf: "regex_pattern"      # optional — if output matches, skip the rest of the pipeline
onError: "abort"             # optional — "abort" (default) or "continue"
```

- **`tool`** — the tool to execute (must exist in the full tool set, not agent-filtered)
- **`args`** — key/value pairs passed to the tool. String values support `{{var}}` template interpolation.
- **`skipIf`** — a regex tested against the tool output. If it matches, the remaining hooks and the agent loop are skipped (for `beforeRun`), or remaining `afterRun` hooks are skipped.
- **`onError`** — what to do when the hook throws, is missing, or returns `success: false`. Defaults to `abort`.

### Failing hooks stop the pipeline

A `beforeRun` hook exists to put data in the prompt. If it fails there is no
data, and a prompt that promises data it doesn't have invites the model to
invent it.

A failed hook (throws, missing tool, or `success: false`) stops the remaining
hooks and reports `failed` to the caller. What happens next is the caller's
choice, and the two differ deliberately:

- **Cron aborts the run.** Nobody is waiting on a cron summary, and a fabricated
  one is worse than none.
- **Chat, delegate, and task-watcher still run the agent.** A hook failure must
  never leave you talking to a silent assistant, so these proceed without the
  hook's output.

This is not hypothetical. A deployment whose Gmail token had expired ran this
hook every 30 minutes:

```yaml
hooks:
  beforeRun:
    tool: gmail
    args: { action: search, query: "after:{{last_run_epoch}}" }
    skipIf: ^No results
prompt: "Below are my recent emails. Summarize any that need my attention."
```

The tool returned `success: false` with an empty output. `skipIf` didn't match
the empty string, so the run proceeded and handed the model a prompt asserting
emails were present when none were. The model obliged, hallucinating an inbox
and DMing the summary — 320 times in 10 days.

Set `onError: "continue"` only when the hook is genuinely optional enrichment.

### Execution flow

1. **beforeRun hooks** execute sequentially before `runAgentLoop`
   - If any hook's `skipIf` matches, the agent loop is skipped entirely
   - If any hook fails (and its `onError` is the default `abort`), the remaining
     hooks are skipped and `failed` is returned; cron then aborts the run, while
     chat/delegate/task-watcher continue
   - In cron, non-empty hook outputs are prepended to the prompt as context
2. The agent loop runs normally
3. **afterRun hooks** execute sequentially after `runAgentLoop`
   - The `{{response}}` template variable contains the agent's response

### Template variables by entry point

| Entry Point | beforeRun vars | afterRun vars |
|---|---|---|
| Cron | `last_run`, `last_run_epoch`, `last_response`, `next_task` | same + `response` |
| CLI, Discord, HTTP, Webhooks, Delegate | `{}` (empty) | `{ response }` |

### Architecture (`packages/core/src/agent/hooks.ts`)

Shared module used by all entry points:

- **`normalizeHooks(hooks)`** — converts `undefined | AgentHook | AgentHook[]` to `AgentHook[]`
- **`mergeHooks(agentHooks?, overrideHooks?)`** — returns `ResolvedHooks` (agent hooks first, overrides appended)
- **`executeHooks(hooks, allTools, templateVars, sessionId, logPrefix?)`** — runs hooks sequentially, returns `{ outputs, skipped }`
- **`applyTemplates(text, vars)`** — replaces `{{key}}` placeholders
- **`hasHooks(hooks)`** / **`EMPTY_HOOKS`** — utilities

`AgentRuntime.resolveHooks({ agentName?, overrideHooks? })` is the main entry point for callers. It reads the agent's hooks from config and merges with any overrides. Each entry point (CLI, Discord, server, delegate, cron) wraps its `runAgentLoop` call with ~5-8 lines of beforeRun/afterRun hook execution.

## Adding a Cron Job

1. Add job config under `cron.jobs` in `config.yaml` (see `CronJobConfig` in `packages/core/src/config.ts`)
2. Set `cron.enabled: true`
3. Run with `--serve` — the scheduler starts automatically
4. Two modes: `wakeAgent: true` (default) runs agent loop; `wakeAgent: false` injects a note into the session
5. Delivery channels: `log` (default, stdout) or `discord` (requires `delivery.target` channel ID)
6. Job state is tracked in the `cron_jobs` DB table
7. Cron jobs can define their own `hooks` and also inherit hooks from their `agent` (agent hooks run first, job hooks appended)

## Prompt Expansion

`packages/core/src/prompts/expand.ts` provides `expandPrompt(text, vars, options?)` for rendering prompt templates. Three forms, applied in order:

1. **`{{include:path}}`** — file inclusion. Relative paths resolve against `options.baseDir` (default `process.cwd()`). Included content is itself expanded recursively, with depth capped by `options.maxIncludeDepth` (default 5). Missing files become an inline `[include error: ...]` marker rather than throwing.
2. **`{{var}}`** — variable substitution from `vars`. Same shape as the legacy `applyTemplates` (which is now an alias for `applyVars`).
3. **`` !`shell cmd` ``** — inline shell expansion. Runs the command via `bash -c`, substitutes its trimmed stdout. Off by default; enable with `prompts.allowShellExpansion: true` in config. Errors become `[!shell error: ...]` so the agent can see what failed.

Wired into:
- `cron/scheduler.ts` — full expansion for `job.prompt` (cron prompts can pull in `!`git log -3``, etc.)
- `task-watcher.ts` — full expansion for `config.prompt`
- `agent/hooks.ts` — `executeHooks` expands string-valued hook args (so a hook `args: { content: "!`date`" }` works)

Static agent instructions (`agents.<name>.instructions`) are *not* currently expanded — they're loaded once and don't benefit from per-iteration shell calls. If you need dynamic instructions, use a cron `beforeRun` hook to write to a memory file and reference it.

Config:

```yaml
prompts:
  allowShellExpansion: false   # gate shell expansion behind this
  shellTimeoutMs: 5000
  maxIncludeDepth: 5
```
