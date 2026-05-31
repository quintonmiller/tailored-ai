# @tailored-ai/browser-mediator

Framework-agnostic browser-control surface for LLM agents.

A thin layer over Playwright that gives an agent a **bounded** browser
tool — no JS eval, no cookie/storage access, no raw HTTP — plus three
defenses you usually have to bolt on yourself:

- **Egress allow-list.** Per-session list of hostnames the page can
  reach. Everything else is aborted at the `route()` layer.
- **Vault `$ns.key` expansion.** Inject secrets into a form via opaque
  tokens; the value never returns to the agent and the audit log
  stores only the masked form.
- **Always-HITL click classifier.** Place-order, submit-payment, and
  friends refuse to fire — the calling code raises an approval out of
  band instead.

No dependency on any particular agent framework. Ships with adapters
for OpenAI function-calling, Anthropic tool-use, and the
[Tailored AI](../core/) Tool interface; you can also dispatch directly.

```bash
pnpm add @tailored-ai/browser-mediator playwright
```

## Quick start (no agent framework)

```ts
import { BrowserMediator } from "@tailored-ai/browser-mediator";

const m = new BrowserMediator({
  egressAllowList: ["example.com"],
  // optional — wire your own secret store
  resolveSecret: async (ns, key) => myVault.get(`${ns}.${key}`),
});

await m.start();
await m.navigate("https://example.com");
console.log(await m.readText());     // sanitised — PANs/SSNs etc redacted
await m.close();
```

`m.click("text=Place your order")` will throw `AlwaysHitlRefusedError`
unless you removed that class from the config. Catch it and route the
operator into your approval flow.

## With OpenAI function-calling

```ts
import OpenAI from "openai";
import { BrowserMediator } from "@tailored-ai/browser-mediator";
import { openaiToolSpec, handleOpenAIToolCall } from "@tailored-ai/browser-mediator/adapters/openai";

const client = new OpenAI();
const mediator = new BrowserMediator({ egressAllowList: ["amazon.com"] });

const response = await client.chat.completions.create({
  model: "gpt-4o",
  messages,
  tools: [openaiToolSpec()],
});

for (const call of response.choices[0].message.tool_calls ?? []) {
  if (call.function.name === "browser_mediator") {
    const r = await handleOpenAIToolCall(mediator, call.function.arguments);
    // feed r.content back as a { role: "tool", tool_call_id, content }
  }
}
```

## With Anthropic Claude tool-use

```ts
import Anthropic from "@anthropic-ai/sdk";
import { BrowserMediator } from "@tailored-ai/browser-mediator";
import { anthropicToolSpec, handleAnthropicToolCall } from "@tailored-ai/browser-mediator/adapters/anthropic";

const client = new Anthropic();
const mediator = new BrowserMediator({ egressAllowList: ["wikipedia.org"] });

const response = await client.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages,
  tools: [anthropicToolSpec()],
});

for (const block of response.content) {
  if (block.type === "tool_use" && block.name === "browser_mediator") {
    const r = await handleAnthropicToolCall(mediator, block.input);
    // feed { type: "tool_result", tool_use_id: block.id, content: r.content, is_error: r.is_error }
  }
}
```

## With Tailored AI core

```ts
import { createTaiTool } from "@tailored-ai/browser-mediator/adapters/tai";

config.tools.browser_mediator = { enabled: true, egressAllowList: ["amazon.com"] };
// TAI's factories already wires this up — nothing else to do.
```

## Roll your own dispatcher

If your framework's tool API doesn't match any of the above, dispatch
to the mediator directly:

```ts
import { BrowserMediator, dispatchToMediator, TOOL_NAME, TOOL_PARAMETERS } from "@tailored-ai/browser-mediator";

const mediator = new BrowserMediator({ egressAllowList: ["example.com"] });
const result = await dispatchToMediator(mediator, { action: "navigate", url: "https://example.com" });
// result = { ok: boolean, output: string, error?: string }
```

`TOOL_PARAMETERS` is a JSON Schema object you can hand to any tool-spec
shape that uses JSON Schema.

## Tool API

| Action | Args | Returns |
|---|---|---|
| `navigate` | `{ url }` | `"Navigated to … Status: … Title: …"` |
| `url` | — | `"<current url>\nTitle: <title>"` |
| `read_text` | `{ max_chars? }` | page text (sanitised, default 4 KB cap) |
| `read_links` | — | lines of `<opaque-id>\t<visible-text>` |
| `click` | `{ node_id }` | confirmation; **refuses on always-HITL classes** |
| `type_text` | `{ node_id, value }` | confirmation; `$ns.key` is expanded server-side |
| `screenshot` | — | metadata (size in bytes); mediator owns the image |
| `wait_for` | `{ text?, selector?, timeout_ms? }` | `"visible"` |
| `close` | — | `"closed"` |

Element ids minted by `read_links` are opaque per-session strings of
the form `el:bm-<hex>:<n>`. They resolve back to the underlying
selector only inside the mediator — the calling agent never sees one.

## What this package will NOT do

- **Containerise Playwright.** v1 runs in-process; subprocess + netns +
  iptables hardening is deliberately out of scope. The boundary against
  prompt injection is the tool API, not the process. Wrap the mediator
  in your own container if you need that.
- **Solve CAPTCHAs or anti-bot.** Vanilla headless Chromium. Plenty of
  sites detect it.
- **Implement workflow learning.** Recording and replaying a sequence
  of approved actions is upstream work the calling agent is expected
  to do. The mediator exposes opaque element ids so a recorder
  *could* be built on top.

## What's defended

Threat model walk-through and reasoning live in
[`docs/browser-mediator-design.md`](../../docs/browser-mediator-design.md)
in the Tailored AI monorepo. Short version: vault refs + the bounded
tool API protect against prompt-injection-driven exfiltration; the
egress allow-list + the cross-tool egress policy protect against
side-channel exfil via sibling tools.

## License

MIT.
