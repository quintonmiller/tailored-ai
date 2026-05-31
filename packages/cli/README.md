# @tailored-ai/cli — `tai`

Lightweight, modular AI agent framework optimized for local LLMs.
The `tai` command runs a REPL or one-shot prompts against a configured
agent, manages sessions, projects, and the web UI.

```bash
npm install -g @tailored-ai/cli
# or use it as a dev dependency in a project
```

## Quick start

```bash
# 1. drop a config.yaml in your cwd (see below)
# 2. start the REPL
tai

# one-shot
tai -m "Summarise today's standup"

# pick a named agent
tai -a coder -m "Add a /healthz route to the server"

# list configured agents, recent sessions, registered projects
tai --list-agents
tai --list-sessions
tai project list
```

## Minimal `config.yaml`

```yaml
provider:
  type: ollama          # or: openai, anthropic, vllm
  model: llama3.2
agents:
  default:
    instructions: "You are a helpful assistant."
    tools: [read, write, web_fetch]
tools:
  read:    { enabled: true }
  write:   { enabled: true }
  web_fetch: { enabled: true }
```

A fully annotated reference is at [`config.example.yaml`](https://github.com/quintonmiller/tailored-ai/blob/main/config.example.yaml).

## What ships

- `tai` REPL with session sidebar, agent switcher, expandable tool results
- `tai project init/list` — register and switch between repos
- `tai --list-agents`, `--list-sessions` for quick inspection
- Built-in web UI served on `tai serve` (chat, agents, sessions, workflows, memory)
- Setup wizard that probes your provider and discovers available models

## Architecture

The CLI is a thin wrapper around [`@tailored-ai/core`](../core/) and
[`@tailored-ai/server`](../server/). See
[`docs/architecture.md`](https://github.com/quintonmiller/tailored-ai/blob/main/docs/architecture.md)
for the full picture.

## License

MIT.
