# @tailored-ai/google-tools

Gmail, Google Calendar, and Google Drive tools for [Tailored AI](https://github.com/quintonmiller/tailored-ai) agents.

```bash
npm install @tailored-ai/google-tools
```

Then import the package once at startup so the tools register with the
runtime:

```ts
import "@tailored-ai/google-tools";
import { AgentRuntime, loadConfig } from "@tailored-ai/core";

const config = await loadConfig("./config.yaml");
const runtime = new AgentRuntime({ config /* ... */ });
```

Enable per tool in `config.yaml`:

```yaml
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

The tools shell out to the [`gog`](https://github.com/quintonmiller/gog)
CLI for OAuth and transport. `gog` stores credentials in the system
keyring; `GOG_KEYRING_PASSWORD` from the environment unlocks them at
runtime. The LLM never sees credentials.

## What ships

| Tool | Actions |
|---|---|
| `gmail` | `search`, `read`, `send`, `mark_seen` |
| `google_calendar` | `list`, `create`, `update`, `delete` |
| `google_drive` | `upload`, `download`, `list`, `delete` |

## How the package plugs in

This package registers itself with `@tailored-ai/core`'s tool-factory
registry on import — the same mechanism a third-party plugin uses. The
factories check the `tools.gmail.enabled` / `tools.google_calendar.enabled` /
`tools.google_drive.enabled` config blocks at runtime and produce the
right tool instances. If the config keys are absent or false, the
factories return empty arrays and the agent never sees the tools.

## Source

[`packages/google-tools/`](https://github.com/quintonmiller/tailored-ai/tree/main/packages/google-tools).

## License

MIT.
