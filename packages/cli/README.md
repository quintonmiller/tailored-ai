# @tailored-ai/cli - `tai`

Tailored AI is a modular framework for running personal agents. The `tai`
command starts the local HTTP API and bundled web UI, runs one-shot prompts,
manages sessions/projects/plugins, and opens the TUI setup/editor.

```bash
npm install -g @tailored-ai/cli
```

## Quick start

```bash
# 1. create ~/.tailored-ai/config.yaml
tai init

# 2. start HTTP API + bundled UI + enabled channels/cron/autopilot
tai

# one-shot
tai -m "Summarise today's standup"

# pick a named agent
tai -a coder -m "Add a /healthz route to the server"

# list configured agents, recent sessions, registered projects
tai --list-agents
tai --list-sessions
tai project list

# install external plugins into the TAI plugin home
tai plugin install @tailored-ai/google-tools
tai plugin list
```

## Minimal `config.yaml`

```yaml
providers:
  openai_compatible:
    baseUrl: http://localhost:11434/v1
    defaultModel: devstral-small-2:latest
  # openai:
  #   apiKey: ${OPENAI_API_KEY}
  #   defaultModel: gpt-4o
  # anthropic:
  #   apiKey: ${ANTHROPIC_API_KEY}
  #   defaultModel: claude-sonnet-4-5-20250929

agent:
  defaultProvider: openai_compatible

plugins: []

agents:
  default:
    instructions: "You are a helpful assistant."
    tools: [read, write, web_fetch, memory]

tools:
  read: { enabled: true }
  write: { enabled: true }
  web_fetch: { enabled: true }
  memory: { enabled: true }
```

A fully annotated reference is at [`config.example.yaml`](https://github.com/quintonmiller/tailored-ai/blob/main/config.example.yaml).

## What ships

- `tai` server mode with HTTP API, bundled web UI, enabled channels, cron, and autopilot
- `tai -m`, `tai -a`, `tai -s`, `--json` for one-shot and scripted runs
- `tai init` / `tai edit` setup and configuration TUI
- `tai project init/list` — register and switch between repos
- `tai plugin install/list/remove/upgrade` — install npm, git, tarball, and local plugins into `<TAI_HOME>/plugins/`
- `tai --list-agents`, `--list-sessions` for quick inspection
- Setup wizard that probes your provider and discovers available models

## Architecture

The CLI is a thin wrapper around [`@tailored-ai/core`](../core/) and
[`@tailored-ai/server`](../server/). See
[`docs/architecture.md`](https://github.com/quintonmiller/tailored-ai/blob/main/docs/architecture.md)
for the full picture.

## License

MIT.
