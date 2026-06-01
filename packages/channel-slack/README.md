# @tailored-ai/channel-slack

Slack channel for [Tailored AI](https://github.com/quintonmiller/tailored-ai). Importing this package registers Slack as a channel factory; the runtime starts it automatically when `channels.slack.enabled: true` is set in `config.yaml`.

Designed as a **reference implementation** of the channel registry (#81) — small enough to read in one sitting (~250 lines) but functional enough to be useful day-to-day. The deeper Discord channel in `@tailored-ai/core` is the feature-complete version; treat this as the canonical example for anyone authoring a third-party channel.

## Install

> **Note**: A first-class `tai plugin install` command is tracked in [#43](https://github.com/quintonmiller/tailored-ai/issues/43). Until that lands, install the package next to your global `tai` so Node's module resolver can find it from the CLI's location.

**npm-globally-installed TAI:**

```bash
npm install -g @tailored-ai/channel-slack
```

**Workspace / monorepo (development):**

```bash
pnpm add @tailored-ai/channel-slack
```

Then in `config.yaml`:

```yaml
plugins:
  - "@tailored-ai/channel-slack"

channels:
  slack:
    enabled: true
    token: ${SLACK_BOT_TOKEN}      # xoxb-... bot user OAuth token
    appToken: ${SLACK_APP_TOKEN}   # xapp-... app-level token with connections:write
    respondToDMs: true
    respondToMentions: true
    # Optional — restrict to specific workspaces
    # allowedTeams:
    #   - T01234567
    # Optional — bind specific channels / DMs to projects
    # projectMappings:
    #   - channel: C01234567
    #     project: my-project
    #   - dm: true
    #     project: personal-notes
```

## Slack app setup

This MVP uses **Socket Mode**, which means no public webhook is required.

1. Create a Slack app at <https://api.slack.com/apps>.
2. Under **Socket Mode**, enable it and generate an app-level token with `connections:write` — this is your `SLACK_APP_TOKEN`.
3. Under **OAuth & Permissions**, install the app to a workspace. Add these bot scopes:
   - `app_mentions:read`
   - `channels:history`, `groups:history`, `im:history`, `mpim:history`
   - `chat:write`
   - `im:write`
   - `users:read`
4. Copy the Bot User OAuth Token — this is your `SLACK_BOT_TOKEN`.
5. Under **Event Subscriptions**, enable events and subscribe to bot events: `message.channels`, `message.groups`, `message.im`, `message.mpim`, `app_mention`.

## Behavior

- **Direct messages** route to the agent loop directly. The bot's reply is posted in-channel (the DM).
- **Channel messages** trigger a response only when the bot is `@`-mentioned. The reply is threaded under the original message.
- The bot mention is stripped from the prompt before the agent sees it.
- Concurrent messages from the same user (per project) are queued — the bot replies "I'm still working on your previous message" until the first finishes.
- Long responses (> 3000 chars) are split on newline / space / hard boundaries.

## What this MVP skips

Deliberately out of scope so the file stays readable:

- Slash commands (`/new`, `/agent`, `/context`, `/tasks`, config-driven commands) — see Discord's `syncCommands` for the reference shape.
- The built-in `/context` + `/tasks` handlers — those would copy ~200 lines from Discord without learning value.
- Multi-user per-agent state — the agent selection is global / config-driven.

Contributions for any of these are welcome.

## License

MIT
