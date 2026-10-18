# Agent interfaces

An agent can send something interactive instead of plain text: a question
with choices, a form, a yes/no confirmation, a card. The web UI draws it under
the agent's reply; every other surface shows a text form of it that still
works; and the model reads that same text form back.

This page is what works today. The full design, including what comes next, is
in [agent-interfaces-design.md](./agent-interfaces-design.md).

## Sending one

Agents get one tool, `interface`, with three actions:

| action | does |
|---|---|
| `send` | send a new component |
| `update` | change one this agent sent that is still open; it is redrawn in place |
| `close` | stop it taking answers, with an optional note |

```
interface(action: "send", kind: "choice",
          props: { question: "Ship today or Monday?", options: ["Today", "Monday"] })
```

The tool is on by default; `tools.interface.enabled: false` withholds it. An
agent with an explicit `tools:` list gets it only by naming it.

## The four kinds

| kind | props | buttons |
|---|---|---|
| `choice` | `question`, `options` (2–10), `allowText?` | one per option, plus a text box with `allowText` |
| `form` | `title`, `fields` (1–10: `name`, `label?`, `type?` text/number/boolean/select/date, `required?`, `options?`), `submitLabel?` | send |
| `confirm` | `summary`, `details?`, `confirmLabel?`, `denyLabel?` | yes and no, or the labels given |
| `card` | `title`, `body?`, `fields?` (`label`, `value`) | whatever the agent passes as `actions` |

A card's `actions` are `{label, effect?, name?}`. Every other kind's buttons
come from its props, and `actions` is refused there, since replacing them
would break the answer.

A bad request comes back to the agent as a correction naming the field, the
same way a world-state write does.

## What an answer does

Each button has an effect:

- **`reply`** (the default): the answer continues the conversation as the
  person's next message, in plain words. A choice sends the option's text, a
  confirm sends its label, and a form sends its title then one `label: value`
  line per field. This is what an `<ask>` button has always done.
- **`event`**: the answer is announced as `interface.action` on the runtime
  bus, naming the component, the action, its `name`, and the agent that sent
  it. Route it with [subscriptions](./world-state.md#waking-agents-on-a-change)
  or `hooks.on`.

A component takes **one** answer. A second click, an answer after the agent
closed it, or one after `expiresInMinutes` has passed is refused, and the web
UI shows the reason ("This question has expired.").

## Where it shows up

- **Web UI:** under the agent's reply, lifted out of the folded tool log, and
  drawn the moment the tool runs during a live turn. A component that was
  updated shows once, as it is now. Answered, closed and expired components
  are drawn finished, with the answer.
- **Discord, Slack and rooms:** the text form, posted with the agent's reply
  (a room turn that says nothing, or passes, posts nothing), for example:

  ```
  [choice c-1a2b3c] Ship today or Monday?
  1. Today
  2. Monday
  Reply with a number.
  ```

  Answering is replying in words; the agent reads it like any other message.
  Native Discord buttons are the next phase.
- **The model** reads the text form in place of the component, so it knows
  exactly what it asked and how it was put.

The text form is written by core when the component is created, never by the
model, and is stored with it, so it reads the same everywhere.

## HTTP API

| route | does |
|---|---|
| `GET /api/interfaces?ids=a,b` | state of several components: `open`, `answered`, `closed` or `expired`, with the answer |
| `GET /api/interfaces/:id` | one component's state |
| `POST /api/interfaces/:id/respond` | `{actionId, value?}`. Returns `{effect: "reply", reply}` for the chat to send, or `{effect: "event"}`. `409` with a reason when it no longer takes answers |

## Adding a kind

A plugin registers a kind through the same registry the built-ins use, and it
is removed when the plugin is:

```ts
ctx.componentKinds.register({
  kind: "rating",
  description: "Rate something out of five.",
  schema: { type: "object", required: ["subject"], properties: { subject: { type: "string" } } },
  defaultActions: () => [1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, label: String(n), effect: { kind: "reply" } })),
  fallback: (props) => `Rate ${props.subject} from 1 to 5.`,
});
```

`fallback` is required: it is what guarantees a component of any kind reaches
any surface. The web UI shows that text form for a kind it has no renderer for.
