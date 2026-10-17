# Agent interfaces — Design

> Status: design, accepted. Second of three linked designs:
> [world state](./world-state-design.md), this one, and
> [live sessions](./live-sessions-design.md).

## Goal

An agent can send an interface, not just text: a question with choices, a form,
a confirmation, a card, a live list. Every surface draws it in its own way or
falls back to something that still works, a person's response comes back as a
structured event, and a component the agent sent can change after it was sent,
including on its own when the state it shows changes.

## Why now: three one-off systems

TAI already has interactive pieces, each locked to one surface:

| Today | Renders on | Missing everywhere else |
|---|---|---|
| `<ask kind="choice">` chat tag | web UI only (`asks.tsx`) | Discord sees raw text |
| Workflow form steps | web UI only (`PendingFormPanel`) | no way to answer from Discord or a phone |
| Approvals | Discord buttons (`discord-approval.ts`) and the trusted-actions PWA | web chat, Slack |

Each solves "ask a person something structured" again, with its own storage,
its own routing for the answer, and one surface. This design replaces all three
with one mechanism.

## Precedents this follows

- **Dashboard widgets** made a widget *data*: a spec with a `type` that selects
  a renderer from a registry. Same here: a component is data; surfaces own
  renderers.
- **The media ladder** made every surface declare what it can show and degrade
  in a fixed order, recording each lossy step as a warning. Same here.
- **Content parts** already carry text and media in one message. A component is
  a third kind of part.

## The model

### A component is a content part

```ts
type ContentPart =
  | { type: "text"; text: string }
  | { type: "media"; media: MediaRef; alt?: string }
  | { type: "component"; component: ComponentSpec };   // new

interface ComponentSpec {
  id: string;                 // stable; used to update it and to route responses
  kind: string;               // open string selecting a renderer: "choice", "form", …
  props: Record<string, unknown>;   // validated against the kind's schema
  actions?: ActionSpec[];     // what each interactive element does
  bind?: StateBinding;        // re-render when this state changes
  expiresAt?: string;         // rendered disabled afterwards
}
```

### The core vocabulary

Small on purpose. Each kind has to render on web, Discord, Slack, plain text
and, later, voice.

| Kind | Props | Discord | Plain text |
|---|---|---|---|
| `choice` | question, options, allowText | buttons (≤5) or a select menu | numbered options, "reply with a number" |
| `form` | title, fields (the workflow input schema: text, number, boolean, select, date) | a button that opens a modal (≤5 fields) | one question at a time |
| `confirm` | summary, details, confirm/deny labels | approve / deny buttons | "reply yes or no" |
| `card` | title, body (markdown), fields, media | embed | heading, body, `label: value` lines |
| `list` / `table` | rows, columns, optional checkboxes | embed fields, truncated with a link | lines or a text table |
| `progress` | label, value / max or steps | embed with a bar | "3 of 5: …" |

A kind is an open registry entry, not an enum. A plugin registers a new kind
with:

- a JSON Schema for its props,
- a **required** text fallback, which is what guarantees that any component
  reaches any surface in some form,

and each surface registers renderers for the kinds it draws natively.

### Surfaces declare what they draw

`SurfaceCapabilities` gains the component kinds a surface renders. Rendering
walks the same kind of ladder media does:

1. native renderer for this kind on this surface,
2. a simpler native form (a long form becomes a series of `choice`s on a
   surface without modals; a wide table becomes cards),
3. the kind's text fallback,
4. later, a spoken fallback for live sessions ("say yes or no").

Every step below the first is logged as a warning, like a media placeholder.

## Responses

Every interactive element has an action, and an action has an effect:

```ts
interface ActionSpec {
  id: string;
  label?: string;
  effect:
    | { kind: "reply" }                                   // becomes a message to the agent
    | { kind: "state"; ref: StateRef; patch: object }     // written directly, no model turn
    | { kind: "event"; name?: string };                   // `interface.action` on the bus
}
```

- **`reply`** is today's `<ask>` behaviour: the answer continues the
  conversation as the person's next message.
- **`state`** writes to [world state](./world-state-design.md) directly, as the
  person who clicked. No model turn is spent. Ticking a checkbox on a plan
  updates the plan, and any agent subscribed to that plan hears about it with
  whatever delivery its subscription chose.
- **`event`** emits `interface.action` with the payload. Subscriptions route it
  exactly like a state change: `immediate`, `queue`, `batch`, `digest` or
  `record`.

Defaults: `reply` for `choice`, `form` and `confirm`; `state` for checkboxes on
a bound `list`.

**Who can respond.** A response is accepted only from someone allowed to talk
to that agent on that surface (Discord's existing authorisation check, the web
UI's bearer auth). The responder is recorded as the actor, which is provenance
like any other state write.

## Updating what was sent

A component has an ID, so the agent can change it after sending:

```
interface(action: "send" | "update" | "close", component, target?)
```

`update` edits the original message in place on every surface it went to
(a Discord message edit, a live update in the web UI over SSE). `close` disables
it with an optional final note.

### Binding to state

```ts
bind: { type: "plan", id: "trip" }
// or a query: { type: "task", where: { assignee: "me", status: "open" } }
```

A bound component re-renders when the state it shows changes, with no agent
involved. The agent sends a plan card once; from then on, whoever edits the
plan, through a tool, a click or another surface, the card stays current
everywhere it was posted.

This is the point where interfaces and world state stop being two features.

## How an agent sends one

Two ways in, one representation:

- **The `interface` tool** for anything structured. Tool arguments are validated
  against the kind's schema, and a failure comes back as a correction naming the
  field, which is what makes this reliable on small local models.
- **`<ask>` tags** stay, as shorthand compiled into a `choice` or text
  component, because they are cheap and models already produce them.

The model never writes fallback text. Core generates it from the props, so a
component costs the model one tool call and nothing more.

## Persistence

Components live in a table (`interface_components`): spec, agent, session or
room, the per-surface message IDs it was posted as, status, expiry. That is
what lets an update or a click work after a restart. Discord's `custom_id`
carries the component and action IDs instead of today's `approve_` prefix.

## Migrations

Each one deletes a one-off system:

1. **`<ask>`** compiles to components. The web UI keeps rendering it; Discord
   gains buttons it never had.
2. **Approvals** become `confirm`. `discord-approval.ts` becomes the generic
   Discord renderer's first user; the trusted-actions PWA uses the web renderer.
3. **Workflow forms** become `form`. `PendingFormPanel` becomes the web form
   renderer; Discord gets a modal; a form step can be answered from anywhere.

## Where it lives

| Tier | Owns |
|---|---|
| Core | the component part, kind registry, `SurfaceCapabilities` extension, the ladder, persistence, response routing, `interface` tool, state binding |
| Core channel / UI | Discord renderers (moving with Discord to its plugin, #620); web UI renderers |
| Built-in plugin | Slack Block Kit renderers in `channel-slack` |
| Deployment | nothing required; custom kinds if it wants them |

## What we are not doing

- **No agent-authored HTML or React in v1.** Portable components are the
  feature. An arbitrary-UI escape hatch is a web-only, opt-in kind later, with
  the security review that implies.
- **No layout system.** A message holds a sequence of parts. Grids and nesting
  are a later question, if ever.

## Phases

| # | Slice |
|---|---|
| 1 | Component part, kind registry with text fallback, persistence, `interface` tool, web renderers for `choice`, `form`, `confirm`, `card`, `reply` and `event` effects |
| 2 | `<ask>` compiles to components |
| 3 | Discord renderers and response routing |
| 4 | State binding, `state` effect, live updates (needs world state phases 1 and 7) |
| 5 | Approvals and workflow forms migrate |
| 6 | `list`, `table`, `progress` |
| 7 | Slack renderers in `channel-slack` |

## Decisions

Settled in review:

1. **A message carries any number of components.** The Discord renderer splits
   across messages when Discord's limits on rows and buttons require it, and
   records a warning when it does.
2. **A response after expiry is rejected**, with a note saying the question
   expired.
3. **A `reply` response wakes the agent the way a message does**, not through
   subscriptions, so there is one rule for it rather than two.
