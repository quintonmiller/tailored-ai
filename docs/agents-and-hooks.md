# Agents, Hooks, Cron & Prompt Expansion

How named agents, delegation, hook pipelines, cron jobs, and prompt templating all fit together.

## Agents & Delegation

Agents are named configurations defined in `config.yaml` under `agents:`. They can override model, description, instructions, tools (allowlist), temperature, maxToolRounds, and hooks.

- `packages/core/src/agent/agents.ts` — `resolveAgent()` merges a named agent with agent defaults
- `packages/core/src/tools/delegate.ts` — `DelegateTool` lets the agent spawn a sub-agent with a specific agent config
- Sub-agents are depth-1 only (they don't get the delegate tool)
- Each delegation creates an ephemeral session keyed `delegate:<parentSessionId>:<uuid>`

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
```

- **`tool`** — the tool to execute (must exist in the full tool set, not agent-filtered)
- **`args`** — key/value pairs passed to the tool. String values support `{{var}}` template interpolation.
- **`skipIf`** — a regex tested against the tool output. If it matches, the remaining hooks and the agent loop are skipped (for `beforeRun`), or remaining `afterRun` hooks are skipped.

### Execution flow

1. **beforeRun hooks** execute sequentially before `runAgentLoop`
   - If any hook's `skipIf` matches, the agent loop is skipped entirely
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
