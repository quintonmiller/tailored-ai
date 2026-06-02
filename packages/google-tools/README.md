# @tailored-ai/google-tools

Gmail, Google Calendar, and Google Drive tools for [Tailored AI](https://github.com/quintonmiller/tailored-ai) agents. Ships as a `register(ctx)` plugin (#47) — the host invokes the package's default export with a `PluginContext` during runtime construction; the plugin registers tool factories that materialize per agent based on `config.yaml`.

## Install

```bash
tai plugin install @tailored-ai/google-tools
```

Then in `config.yaml`:

```yaml
plugins:
  - "@tailored-ai/google-tools"

tools:
  gmail:
    enabled: true
    account: you@gmail.com
  google_calendar:
    enabled: true
    account: you@gmail.com
  google_drive:
    enabled: true
    account: you@gmail.com
    folder_name: "TAI artifacts"
```

## How auth works

The tools shell out to the [`gog`](https://github.com/quintonmiller/gog) CLI for OAuth and transport. `gog` stores credentials in the system keyring; `GOG_KEYRING_PASSWORD` from the environment unlocks them at runtime. The LLM never sees credentials.

## What ships

| Tool | Actions |
|---|---|
| `gmail` | `search`, `read`, `send`, `mark_seen` |
| `google_calendar` | `list`, `create`, `update`, `delete` |
| `google_drive` | `upload`, `download`, `list`, `delete` |

## How the package plugs in

The default export is a `Plugin` — `(ctx) => { ctx.tools.register("gmail", ...); ... }`. The host calls it once with a `PluginContext`. The factories check `tools.<id>.enabled` at agent build time and produce the right tool instance, or return an empty array so the agent never sees the tool.

## Source

[`packages/google-tools/`](https://github.com/quintonmiller/tailored-ai/tree/main/packages/google-tools).

## License

MIT.
