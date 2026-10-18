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

A card's `actions` are `{label, effect?, name?, patch?, ref?}`. Every other
kind's buttons come from its props, and `actions` is refused there, since
replacing them would break the answer. Buttons put inside `props` instead of
beside it are moved to where they belong.

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
- **`state`**: the click writes `patch` to a [world-state](./world-state.md)
  record, as the person who clicked. No model turn runs. See
  [Cards that show a record](#cards-that-show-a-record).

A component takes **one** answer. A second click, an answer after the agent
closed it, or one after `expiresInMinutes` has passed is refused, and the web
UI shows the reason ("This question has expired."). State buttons are the
exception: they don't answer, so they can be clicked again and again until
the component is closed or expires.

## Cards that show a record

A card can be bound to a world-state record with `bind`. It then shows the
record instead of fixed text, and its buttons can change the record directly:

```
interface(action: "send", kind: "card",
          bind: { type: "plan", id: "trip" },
          actions: [{ label: "Start", effect: "state", patch: { status: "active" } },
                    { label: "Done", effect: "state", patch: { status: "done" } }])
```

- **What it shows:** the record's title field (the type's `title`) as the
  title, and every other field as a line. A type without a title field uses
  the agent's `props.title`. `props.body` stays as the agent wrote it. Fields
  the agent gives are left out, and it is told so, since the record supplies
  them; a local model copied the record into `fields` on every run, and a
  refusal cost it a round each time.
- **Who can bind what:** the record is read as the agent, so a card can only
  show what the agent's own `state` tool could read. A record it can't see is
  refused, with the same sentence the tool would give.
- **Staying current:** whoever changes the record (through the tool, the
  State page, another card or a plugin), the card redraws, in the web UI and
  in every Discord message it was posted as. A deleted record says so, and
  its buttons stop. On Discord a burst of changes becomes one edit, which
  keeps a busy record inside Discord's edit rate limit.
- **State buttons:** `patch` is written to the bound record, or to the
  button's own `ref: {type, id}` when it names one. The write is recorded as
  the person who clicked (`owner` in the web UI, `discord:<id>` on Discord),
  with the component's id as its source, and goes through the type's schema
  like any other write; a patch that doesn't fit is refused with the reason.
  Any agent subscribed to that record's changes hears about it through its
  subscription, with the delivery mode the subscription chose.
- **What the agent is told:** the tool's reply says the state buttons write
  directly and nothing comes back, so the agent doesn't wait for an answer.
  Unlike a `reply` button, a state button runs no agent, so a click works
  even while the agent is busy or agents are paused.

A surface that can't draw buttons shows the card's text form with the record
as it was when sent, and "Options: Start, Done." The person replies in words,
and the agent can make the change with its `state` tool.

## Where it shows up

- **Web UI:** under the agent's reply, lifted out of the folded tool log, and
  drawn the moment the tool runs during a live turn. A component that was
  updated shows once, as it is now. Answered, closed and expired components
  are drawn finished, with the answer. A component already on screen
  changes as it happens: answered on Discord, updated or closed by its
  agent.
- **Discord:** drawn with Discord's own controls, each component in a
  message of its own under the agent's reply. A choice is a row of buttons,
  with "Something else" opening a text box when it allows free text; a
  confirm is a green and a grey button; a card is an embed with its buttons;
  a form is a button that opens a pop-up form. Clicking rewrites the message
  to show the answer and who gave it, with the controls disabled, and the
  agent carries on in the same conversation as if you had typed the answer.
  See [Answering on Discord](#answering-on-discord).
- **Slack and rooms:** the text form, posted with the agent's reply (a room
  turn that says nothing, or passes, posts nothing), for example:

  ```
  [choice c-1a2b3c] Ship today or Monday?
  1. Today
  2. Monday
  Reply with a number.
  ```

  Answering is replying in words; the agent reads it like any other message.
- **The model** reads the text form in place of the component, so it knows
  exactly what it asked and how it was put.

The text form is written by core when the component is created, never by the
model, and is stored with it, so it reads the same everywhere.

## Answering on Discord

**Who can answer.** The answer becomes the next message in the conversation
that asked, so it has to come from that conversation's person:

- In a conversation with one person (a DM, or an @mention in a server), only
  that person. Anyone else who clicks is told the question was asked of
  someone else.
- In a conversation nobody on Discord owns, such as a scheduled run or an
  agent woken by a [subscription](./world-state.md#waking-agents-on-a-change),
  only the owner set in `channels.discord.owner`. A DM is seen only by the
  person it was sent to, so there they can always answer.
- `channels.discord.allowedGuilds` applies, as it does to messages.

**When a click is refused.** The question stays open, so you can click again:

- The agent is still working on your previous message.
- Agents are paused with `scope: all`.

**Limits.** A form with more than five fields, more than a Discord pop-up
holds, is posted as its text form, and answered by replying in words. Pop-up
fields hold only text, so a number, a yes/no or a pick from a list is checked
when you send it, and a value that does not fit is refused with the reason.

**Staying current.** TAI remembers each message it posted a component as, and
edits that message when the component changes:

- An agent's `update` redraws the message in place rather than posting a copy.
- An answer given anywhere, in the web UI or another Discord message, shows on
  every copy with its controls disabled.
- A component the agent closes shows "Closed", with its note.
- A bound card follows its record.

An expired component keeps its buttons until someone clicks one; the click
says it has expired.

**State buttons** on a bound card write the record and redraw the card in
place, with its buttons still live. They don't wait on the agent, so they
work while it is busy.

## HTTP API

| route | does |
|---|---|
| `GET /api/interfaces?ids=a,b` | state of several components: `open`, `answered`, `closed` or `expired`, with the answer |
| `GET /api/interfaces/:id` | one component's state |
| `GET /api/interfaces/events` | a server-sent stream: a `component` event, shaped like the state route's, each time a component changes (answered anywhere, updated, closed) |
| `POST /api/interfaces/:id/respond` | `{actionId, value?}`. Returns `{effect: "reply", reply}` for the chat to send, `{effect: "event"}`, or `{effect: "state", record}` with the record as the click left it. `409` with a reason when it no longer takes answers or the write doesn't fit |

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
