---
"@tailored-ai/core": patch
---

Plugins can register slash commands.

Every chat command was hardcoded in `discord.ts` — a plugin had no way to add one, so anything wanting a command had to be a core change. This adds the seam, shaped like the HTTP route seam next door: core owns a transport-neutral `SlashCommandRegistry` of descriptors, and each channel adapts them onto its own command surface. Core never imports discord.js from the registry, so the dependency direction stays channel → core and a Slack or Telegram channel can serve the same descriptors.

```ts
ctx.commands.register({
  name: "instance",
  description: "Show or switch the running TAI instance",
  options: [{ name: "name", description: "Instance", type: "string", autocomplete: suggest }],
  handler: async (inv) => ({ content: `switching to ${inv.options.name}` }),
});
```

Unlike HTTP routes these cannot be namespaced — chat platforms use a flat command namespace with no separator to hide a prefix behind — so `register` throws on a name that is built-in (`RESERVED_COMMAND_NAMES`) or already taken by another plugin. Refusing is the honest failure; the alternative is a plugin silently shadowing `/room` or `/memory` for everyone in the guild.

The Discord adapter defers the reply before invoking a handler. Plugin handlers do arbitrary work, and Discord kills an interaction that goes three seconds without a response; deferring buys fifteen minutes. A handler that throws is caught and reported into the interaction rather than leaving it hanging as "the application did not respond".
