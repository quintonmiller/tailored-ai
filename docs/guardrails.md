# Guardrails

A guardrail is a mechanical check an agent's message has to pass before it is
posted to a room. A message that fails is **not delivered**; the reason is
handed back to the agent as a correction, and it gets one attempt to say the
thing properly.

Today that covers every way an agent posts to a room. A direct reply in a
channel conversation, the web UI or the CLI is **not checked yet**.

## What this is for

Instructions are advice, and a busy prompt dilutes them. An agent can be told
plainly to keep a certain kind of reply short and still write four paragraphs,
because that instruction is one sentence competing with a persona, a system
prompt, tool schemas and a conversation.

The deployment this came from measured the gap: the same note was given to the
same agent in six separate reviews across three sessions, and the behaviour did
not move once. The only thing that worked was rewriting the agent's persona,
which is not a fix that scales to the next nine rules.

So a guardrail is what you reach for when you know exactly what the rule is,
the rule is mechanical, and telling the agent has already failed.

## What it is not

- **Not a safety or moderation layer.** It runs on an agent's own outgoing text
  at one point in one process, with no trust boundary anywhere near it. Use it
  for house style, not for anything that has to hold against an adversary.
- **Not a rewriter.** A guardrail refuses; it never edits. Silently rewriting
  would put words in an agent's mouth that it cannot see and would then reason
  about a message it never sent.
- **Not a filter that swallows.** Dropping a message loses the turn and teaches
  the agent nothing. Refusing with a reason costs one more model call and gets
  a better message.

## Declaring one

Guardrails are per agent, in `config.yaml`:

```yaml
agents:
  room-keeper:
    instructions: ...
    guardrails:
      # When reporting a die roll, be brief.
      - use: text
        options:
          when: "\\[ROLL\\]"
          maxChars: 400
          message: "Say the number and react to it. The scene comes after."
      # Never, on any message.
      - use: text
        options:
          deny:
            - "\\blet me think\\b"
            - "\\bit'?s my turn\\b"
```

Each entry is an open selector (`use`) plus an opaque `options` bag, the same
shape `tasks.backend` and `sandbox.backend` use. Core does not know any
guardrail's option names, so a plugin's guardrail validates exactly as well as
the built-in one.

`surfaces` narrows where a rule applies. Core checks one surface today, `room`:
every post that reaches a room. Omit it and the rule applies to every surface
that is checked. It is an open string so that a later surface, or one a plugin
adds, can be scoped the same way.

```yaml
      - use: text
        surfaces: [room]
        options: { maxChars: 2000 }
```

## The built-in `text` guardrail

Core ships one, deliberately domain-free:

| Option | Effect |
|---|---|
| `when` | Only run this rule when the body matches this pattern |
| `maxChars` / `maxWords` | Length caps |
| `deny` | List of patterns; any match refuses |
| `limit` | `[{ pattern, max }]` — at most `max` matches |
| `message` | Appended to whichever reason fires |
| `caseSensitive` | Default false |

`when` is what makes the length caps usable. A blanket "never write more than
700 characters" is nearly always wrong, because the same agent legitimately
writes long and short messages. "When you are reporting a die roll, never write
more than 400" only bites the case it is about.

A pattern that will not compile is logged once and skipped, rather than
refusing every message the agent ever writes with an error about a regex.

## Writing your own

Register a factory; it takes the opaque options and returns something with a
`check`:

```ts
import { registerGuardrail } from "@tailored-ai/core";

registerGuardrail("no-links", (options) => ({
  id: "no-links",
  check(text, ctx) {
    if (!/https?:\/\//.test(text)) return { ok: true };
    return { ok: false, reason: `${ctx.agent} may not post links in ${ctx.surface}.` };
  },
}));
```

`check` may be async, so a guardrail that needs a model call or a lookup is
possible — but note it runs on every message, on the turn's critical path.

The `reason` is delivered verbatim into the agent's next prompt, so write it as
a correction it can act on: what was wrong and what to do instead.

## Where they run

Three points — every way a message reaches a room. Nothing outside a room is
checked yet:

1. **The correction ladder**, alongside the existing checks for malformed
   output. A guardrail failure becomes the turn's one correction round, so the
   agent is told and re-runs. Guardrails sit *below* the malformed-output
   branches: a reply that is not yet a message cannot be judged on what kind of
   message it is.
2. **Delivery.** A message that still fails after its correction is dropped and
   logged with the reason and the text. That mirrors how raw tool-call markup
   is handled — correct once, then refuse — and the log matters, because a room
   that simply goes quiet gives nobody a reason to suspect a rule.
3. **The `room` tool's `post`.** An agent that posts by calling the tool never
   reaches either of the above, and posting is the only way to address someone
   with `to` — so a deployment whose agents are told to use it had guardrails
   that parsed, resolved, and never ran. Here the failure is returned as a tool
   error rather than a drop: the agent is still mid-turn and has rounds left,
   so it can say the same thing within the rule.

The first two are checked only when the reply is what will actually be posted.
An agent that already spoke through the `room` tool has sent different text
(checked at 3), and one that called `pass` is sending none.

A guardrail that fires is logged whether or not the retry satisfies it. Without
that, a rule doing its job and a rule that is quietly inert look identical from
outside — both produce silence.

## They fail open

A guardrail that throws, or names an id nothing registered, is reported and
skipped, and the message goes out.

This is the opposite of what hooks do, on purpose. A `beforeRun` hook supplies
data the prompt then claims to have, so running without it produces confident
fiction — hooks fail closed. Nothing downstream of a guardrail depends on it
having run, and an agent silenced indefinitely by a bug in a quality check is a
much worse failure than the drift it was watching for.
