# Browser mediator: design

A flexible browser-control surface for the LLM agent that works on **any
website** while preventing credential and PII exfiltration. Sits beside
the existing trusted-actions executor (which keeps the strict, per-site,
no-LLM-credentials path for Amazon purchases) and trades some of that
strictness for generality.

This doc is the canonical reference for the six-phase build:

| Phase | Bean | Scope | Status |
|---|---|---|---|
| 1 | `ptask_e242a54a` | Tool-only browser surface + network sandbox | v1 ✓ Shipped (in-process Playwright; netns/iptables hardening deferred) |
| 2 | `ptask_83a56ce9` | Vault primitive (`$ref` expansion) | ✓ Shipped — `tai vault` CLI live, expansion wired into mediator |
| 3 | `ptask_c28189e9` | Workflow recorder + matcher | Backlog — design has no blocker but the v1 mediator gates on always-HITL alone |
| 4 | `ptask_6323c149` | Always-HITL action classes | ✓ Shipped — gates `click()` inside the mediator |
| 5 | `ptask_21387cbd` | Output sanitizer | ✓ Shipped — wired into every mediator return |
| 6 | `ptask_ea162d8d` | Agent egress crosstalk policy | ✓ Shipped — `web_fetch` consults `egress-policy` while a session is live |

When a phase ships, mark its row "✓ Shipped" and add a short outcome
note under the phase section below. The phase bean stays the source of
truth for acceptance criteria; this doc is the *why*.

## Goals

1. Agent can drive any website end-to-end: log in, navigate, fill forms,
   click buttons, read responses.
2. Credentials and PII (passwords, addresses, last-4 cards, full order
   history) never enter the LLM context, even transitively.
3. First-time use on a new site is HITL-heavy by design; repeated
   workflows are mostly auto-approved.
4. A prompt-injection attack on the agent cannot exfiltrate vault
   contents, even with active cooperation from the page.

## Non-goals

- Cryptographic guarantee against exfiltration. The mediator is a
  *bounded surface* with *layered defenses*; a determined attacker who
  controls both the agent and the page may still leak summarised
  information (e.g. trick the agent into reading a malicious page out
  loud). We mitigate, not eliminate.
- Replacing the trusted-actions executor for Amazon purchases. The
  strict path stays — it's the safest workflow we have. The mediator is
  for everything the strict path doesn't cover.
- Stateful "agent learns the web" magic. Workflow learning is per-site,
  per-task, deterministic, and entirely operator-visible.

## Threat model

What we defend against:

| Threat | Defense |
|---|---|
| Agent reads its own conversation, finds password verbatim, sends it to attacker | Vault references — password is never in agent context; `$amazon.password` is opaque |
| Page exfiltrates cookies/localStorage via JS the agent is tricked into running | No JS-eval tool; no `cookie` / `storage` accessors in tool surface |
| Agent uses `web_fetch` to POST captured page text to attacker's server | Phase 6 egress crosstalk policy — agent's outbound network is per-task allow-listed; vault namespaces and mediator session IDs are scrubbed from outbound bodies |
| Page sets `Set-Cookie` that exfiltrates a `Referer` containing tokens | Mediator runs in its own network namespace with per-task egress allow-list (iptables + DNS intercept) |
| Agent tries to bypass HITL by issuing many small auto-approved actions | Workflow matcher requires *exact* recorded selector path; novel selectors → HITL |
| Agent records a malicious workflow under the guise of a benign one | Workflows are stored with the page DOM snapshot of approval points; operator can review before re-enabling |
| Page convinces agent to type secrets *outside* a vault ref (e.g. agent improvises) | Output sanitizer (Phase 5) — last line scrub for vault namespaces in any string the agent emits |

What we **accept** as residual risk:

- An operator who approves a malicious first run is owned. The trust-
  on-first-use model assumes the operator inspects the recorded steps.
- Side-channel exfiltration via approved actions (right merchant, wrong
  item, similar cost). Same residual risk as the strict executor.
- Page can fingerprint the browser. Mediator uses stealth chromium but
  we don't claim anti-fingerprinting guarantees.

## Architecture

```
┌─────────────┐    tool API (bounded)     ┌──────────────────────┐
│ LLM agent   │ ─────────────────────────▶│ Browser mediator     │
│ (TAI core)  │ ◀──────────────────────── │  - Playwright        │
└─────────────┘    sanitised results      │  - vault deref       │
       ▲                                  │  - workflow record   │
       │ HITL prompts                     │  - audit             │
       │ via push                         └──────────┬───────────┘
       │                                             │ navigates
┌─────────────┐                                      ▼
│ Operator    │  ◀── approval push ──┐      ┌──────────────┐
│ (PWA)       │  ─── approve/deny ──▶│      │ network ns   │
└─────────────┘                       │      │ (per-task    │
                                      │      │  allow-list) │
                                      │      └──────┬───────┘
                                      │             │
                                ┌─────┴──────┐      ▼
                                │ vault      │   internet
                                │ (age blob) │   (allow-listed
                                └────────────┘    domains only)
```

The **mediator is a separate process** from TAI core (same isolation
pattern as the trusted-actions executor). It exposes a Unix domain
socket — no TCP port — so only processes with filesystem access can
reach it.

### Three primitives

1. **Tool-only API** (Phase 1). The agent gets a bounded set of tools:
   `navigate`, `read_text`, `read_links`, `click`, `type_text`,
   `screenshot`, `wait_for`, `url`. No `eval_js`, no `read_cookie`, no
   `read_storage`, no raw HTTP. DOM nodes are referred to by opaque ids
   the mediator hands out — selectors don't leak.
2. **Vault references** (Phase 2). The agent uses opaque strings like
   `$amazon.password` in `type_text`. The mediator resolves them at the
   boundary by reading from the age-encrypted vault. The actual value
   never enters the agent's context. Same vault format as the
   trusted-actions password store; namespaces are first-class.
3. **Workflow learning** (Phase 3). First run on a new site: every
   action requires HITL approval, the mediator records `(url pattern,
   selector path, action, value-template)` tuples. Subsequent runs:
   exact matches are auto-approved; novel steps trigger HITL again.
   Always-HITL action classes (Phase 4) — submit-payment, place-order,
   change-shipping-address — never auto-approve regardless of match.

### Network sandbox

The mediator process runs in its own Linux network namespace. Per-task
egress is controlled by an iptables allow-list keyed on destination
domain (resolved via a DNS intercept). The default policy is **deny**:
a new task starts with zero allowed domains; the operator (via PWA, or
implicitly via the recorded workflow) names the domains for that task.

This is the load-bearing exfiltration defense. A prompt-injected agent
that talks its way into reading a sensitive page still can't send the
content anywhere — TCP to anywhere outside the allow-list is dropped.

## Tool API surface (Phase 1)

```ts
navigate(url: string): { session_id: string }
url(): { url: string, title: string }
read_text(opts?: { node_id?: string, max_chars?: number }): { text: string, truncated: boolean }
read_links(opts?: { node_id?: string }): Array<{ text: string, node_id: string }>
click(node_id: string): { ok: boolean }
type_text(selector: string, value: string): { ok: boolean }
screenshot(opts?: { node_id?: string }): { image_url: string }  // returned as mediator-owned URL, not bytes
wait_for(opts: { text?: string, selector?: string, timeout_ms?: number }): { ok: boolean }
```

Notes:

- **No `eval_js`.** Anything not in this surface is impossible. Adding
  one is a code change, not a runtime decision.
- **`node_id` is opaque.** It's a UUID the mediator mints when the
  agent reads the page. Stable for the session; meaningless to the
  agent. This is what lets workflow recording match selectors without
  exposing them.
- **`type_text` value** runs through the vault expander (Phase 2)
  before reaching the page. `$ns.key` substrings are dereferenced; the
  raw value never returns to the agent.
- **`screenshot` returns a URL**, not bytes. The image lives on the
  mediator; the agent can pass the URL to a vision model via a
  separate, sanitiser-gated path. Most agents don't need this; included
  for debugging the recorder.
- **`read_text` is bounded** (default 4 KB, configurable to 32 KB).
  Avoids "read the whole page into context" patterns.

### What's deliberately missing

- `set_cookie` / `read_cookie` / `clear_storage`. The mediator manages
  storage; the agent doesn't see it.
- `download_file`. Out of scope for v1.
- `new_tab` / `switch_tab`. Single-tab sessions only — keeps the
  workflow recorder tractable.
- `back` / `forward`. Use `navigate` to a specific URL.

## Vault primitive (Phase 2)

Storage format mirrors the existing trusted-actions password vault:
age-encrypted JSON blobs under `secrets/vault/`, decrypted with the
operator passphrase at mediator startup.

```
secrets/vault/amazon.age   →   { "password": "…", "totp_secret": "…" }
secrets/vault/banking.age  →   { "username": "…", "password": "…" }
```

Lookup syntax in `type_text` values: `$amazon.password`,
`$banking.username`. The mediator does the substitution server-side
**after** the call leaves the agent's process. Three rules:

1. References are **whole-token only**. `password is $amazon.password`
   expands; `pass$amazon.passwordword` does not (would be a vector for
   the agent to encode data in surrounding text).
2. References resolve **once per call**. The expanded string is fed to
   Playwright and the buffer is zeroed in `finally`.
3. References never appear in any return value. If the agent calls
   `read_text` and the page reflects the password back (echo bug), the
   sanitiser (Phase 5) catches it before return — and audit-logs the
   page leak.

CLI: `tai-mediator vault set <namespace> <key>` reads stdin no-echo
(same UX as `setup amazon-password`). Rotation: `--force`.

## Workflow learning (Phase 3)

Goal: first purchase on a new site is tedious; the hundredth is one tap.

A workflow is a recorded list of `(url_pattern, action, target,
value_template)` tuples, plus DOM snapshots of the approval points for
operator review. URL patterns are origin + path (no query). Target is
an opaque selector-path the mediator generates from the live DOM. Value
templates substitute `$args.foo` for caller-provided arguments and
`$ns.key` for vault references.

Recording mode:
- Operator triggers "record workflow X" via PWA.
- Every agent action prompts the operator (push notification).
- Operator approves each step; mediator captures the tuple + DOM
  snapshot of the page before the action.
- Final step is marked "terminal" by the operator (e.g. place-order).

Replay mode:
- Agent requests workflow X with arguments.
- Mediator drives the steps; matches each live page against the
  recorded snapshot (selector-path match, not pixel match).
- Match → execute. No match → fall back to HITL for that step alone;
  remaining steps stay on rails.
- Terminal step always HITL (Phase 4 invariant).

What's stored:
- `workflows/<id>.json` — the tuple list and snapshots.
- `workflows/<id>.audit.log` — every replay with the actual values
  used, hash-chained like trusted-actions.

What's *not* stored:
- The vault values themselves. Templates store `$ns.key`, not the
  resolved string.

## Always-HITL action classes (Phase 4)

Some action classes always require fresh operator approval, regardless
of workflow match:

- Submit payment / place order / confirm purchase
- Change shipping address, billing address, payment method
- Change account password / email
- Delete account / cancel subscription
- Transfer funds / send money

Detection is heuristic on the live DOM at click-time: button text
matches `^(place\s+order|pay|confirm purchase|submit payment|…)`, or
the recorded tuple was marked terminal. False positives are cheap (one
extra tap); false negatives are catastrophic — bias toward over-prompt.

The list is in `packages/browser-mediator/src/hitl/classes.ts`, a flat
array of regex + locale. Add to it via code change; the agent cannot
extend the list.

## Output sanitizer (Phase 5)

Final defense against vault leakage in any string the mediator returns
to the agent.

Every return value passed across the agent boundary is regex-scrubbed
for:
- Known vault namespace tokens (`$amazon.…` etc) — replaced with
  `[REDACTED:vault-namespace]`.
- 12-19 digit numbers passing Luhn (probable card numbers).
- Strings matching `\b\d{3}-\d{2}-\d{4}\b` (SSN format).
- Any literal vault value the mediator currently has loaded in memory
  (last-resort defense against echo bugs in page text).

A hit doesn't fail the call — it scrubs the field and audit-logs the
hit with `sanitiser.tripped { field, pattern }`. Operator can review.

The sanitiser pattern set is configurable per deployment, but the
in-memory vault-value scrub is always on.

## Agent egress crosstalk policy (Phase 6)

Phase 1 sandboxes the *mediator* network. Phase 6 sandboxes the
*agent* network — necessary because the agent has its own tools
(`web_fetch`, `web_search`, possibly future MCP outbound calls) that
could exfiltrate anything the mediator returned.

Rules:

- Each task scope gets an outbound allow-list (`agent.egress.allowed`).
- When the agent is in a workflow that uses the mediator, the
  allow-list is **automatically narrowed** to: TAI's own backend,
  approved LLM provider endpoints, and the mediator's exposed read
  surface. No `web_fetch` to arbitrary URLs while the agent has a live
  mediator session.
- A `restore_egress` action ends the mediator session and restores the
  normal allow-list.
- Vault namespaces and mediator session IDs are stripped from outbound
  HTTP bodies via the existing output sanitiser (Phase 5 pattern set
  applies to agent-outbound, not just mediator-return).

Implementation:
- TAI's outbound HTTP path goes through a single client; we add a
  per-task allow-list check.
- The mediator publishes its current allow-list update to the TAI
  runtime via the existing `runtime` event bus.

## Comparison vs the strict-policy v1 design

We considered a v1 design that was strict per-domain YAML policies — a
schema per site enumerating exactly which selectors the agent could
touch. That design is **safer** and **more brittle**: it can't handle
sites we haven't pre-modeled, and every site needs operator setup
before first use.

The mediator trades that strictness for:
- General applicability (works on any site immediately)
- Trust-on-first-use as the operator's escape hatch (you decide what's
  trusted, not us)
- Workflow learning as the long-term ergonomic story

We keep the strict path for Amazon purchases via the existing
trusted-actions executor. Workflows the operator wants maximum safety
on stay there; workflows that don't need a hand-coded adapter use the
mediator.

## Open questions

- **Vault value redaction in screenshots.** The Phase 5 sanitiser
  doesn't OCR images. If the page renders `$amazon.password` in plain
  text and the agent screenshots it, the sanitiser can't catch it
  unless we OCR. Tentatively: don't render screenshots to a vision
  model unless explicitly approved by operator.
- **TOTP support.** Vault namespaces can hold a TOTP secret; the
  mediator can compute a code at substitution time
  (`$amazon.totp_now`). Worth shipping in Phase 2.
- **Workflow versioning when sites redesign.** A recorded workflow
  breaks when the site changes its DOM. Current plan: matcher fails →
  HITL → operator can re-record from that step. Acceptable for v1.
- **Multi-account.** Vault is keyed by namespace, not account-within-
  namespace. If the operator has two Amazon accounts, they live in
  `amazon_personal` and `amazon_work`. Workflows reference the
  namespace explicitly.

## Status

- 2026-05-28: epic + 6 phase beans created. Design doc drafted (this
  file). Phase 1 picked up by coder.
- 2026-05-28: **decoupled into its own package.** The mediator
  is now `@tailored-ai/browser-mediator` (`packages/browser-mediator/`),
  with zero dependency on `@tailored-ai/core` or anything else
  TAI-specific. The package ships three adapter modules — OpenAI
  function-calling, Anthropic tool-use, and the TAI Tool interface —
  plus a raw `dispatchToMediator()` for any other framework.
  TAI's `packages/core/src/browser/*` files are now thin shims that
  re-export from the new package and wire up the
  better-sqlite3-backed vault as a `resolveSecret` callback. README
  in the new package documents each adapter with copy-paste
  examples. 1188 core tests + 11 new package tests all green.

- 2026-05-28: **v1 mediator landed end-to-end.** Five of six phases
  shipped; P3 (workflow recorder) is the only deferred phase and isn't
  load-bearing for v1 since always-HITL gates the risky clicks.
  - `packages/core/src/browser/mediator.ts` — real Playwright,
    opaque element ids, egress allow-list via `page.route()`,
    audit hook, vault expansion in `type_text`, sanitizer on
    every return, always-HITL gate on `click`.
  - `packages/core/src/tools/browser-mediator-tool.ts` — Tool
    surface registered when `tools.browser_mediator.enabled: true`
    in config.yaml.
  - `packages/core/src/browser/egress-policy.ts` — process-global
    crosstalk policy; `WebFetchTool` consults it while a session is
    active and refuses non-allow-listed hosts (intersection rule
    closes the multi-session widening attack).
  - `packages/cli/src/commands/vault.ts` — `tai vault {set,get,
    list,delete,key generate}` shipped, wired into the CLI entry.
  - Tests: 25 new mediator/policy/integration tests, 1182/1182 in
    the core suite. Integration tests boot a local HTTP server and
    a real Chromium, then prove: egress blocks, opaque ids, vault
    expansion masks audit, sanitizer scrubs a Stripe-test PAN.
  - **v1 trade-offs vs full design:** in-process Playwright (no
    container, no netns/iptables) — the boundary is the tool API,
    not the process. Subprocess + container hardening is a v2
    deliberate follow-up under a new bean. Workflow recorder (P3)
    also deferred.

- 2026-05-28: coder review (pre-v1). Landed self-contained modules
  from P2 / P4 / P5 onto main:
  - `packages/core/src/vault/{vault,ref-parser,schema}.ts` + CLI
    command (P2 core; AES-256-GCM vault, namespace.key parsing,
    `$ns.key` expansion at the boundary).
  - `packages/core/src/browser/always-hitl.ts` + tests (P4 logic;
    domain-scoped action-class deny list with default fallback).
  - `packages/core/src/tools/browser-output-sanitizer.ts` + tests
    (P5; Luhn-PAN, SSN, IBAN, phone, email, address scrub).
  - All 1124 core tests pass. Sanitizer + always-HITL are pure-logic
    modules awaiting integration into the Phase 1 mediator.
  - P1 / P3 / P6 sent back: P1 was a skeleton with a fake backend
    (Playwright service URL placeholder, hardcoded fake response,
    no compose file, no network-policy tests — failed acceptance
    criteria); P3 was 1132 lines uncommitted with 649 in types.ts
    alone, stalled twice; P6 produced nothing. All three need
    proper scope cuts before re-attempting.

When each phase lands, update the table at the top.
