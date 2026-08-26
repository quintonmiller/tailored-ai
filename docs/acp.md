# Driving another coding agent (ACP)

TAI can hand a coding task to an external agent — Claude Code, Codex, anything
that speaks the [Agent Client Protocol](https://agentclientprotocol.com) — over
a real session rather than a subprocess call.

```yaml
tools:
  coding_agent:
    enabled: true
    agents:
      claude:
        command: claude-code-acp
        # Claude Code refuses to start inside another Claude Code session.
        # Clearing these is required when TAI itself was launched from one.
        env: { CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "" }
      codex:
        command: codex-acp
        # Pin a model: the adapter's bundled Codex fails to parse the live
        # model list if it names a reasoning level the build predates.
        args: ["-c", "model=gpt-5.5"]
    defaultAgent: claude
    permissions: deny        # the default; see below
```

**Neither Claude Code nor Codex speaks ACP itself.** `claude` has no ACP mode
and `codex app-server` is Codex's own protocol. Both are reached through the
adapters Zed publishes — `@zed-industries/claude-code-acp` and
`@zed-industries/codex-acp` — which is a good argument for core shipping no
agent defaults: the thing you launch is usually not the thing you think of as
the agent, and it moves independently of both.

An agent then calls it like any other tool:

```
coding_agent(prompt: "add a --dry-run flag to the export command and a test for it")
```

## Why it is in core

The same reason [MCP](./mcp.md) is: it is a protocol-level capability, the
`openai_compatible` of agent-driving. Core ships the generic protocol client and
plugins ship vendor adapters — the split the provider family already uses.

The property that keeps that honest is that **core knows the protocol and never
a vendor**. There is no built-in agent list, no default command, and no agent's
name appears in `DEFAULT_CONFIG`. `agents` is the only thing that decides what
runs, exactly as `mcp.servers` is.

`@agentclientprotocol/sdk` is an optional dependency of core, dynamically
imported on first use. If it is absent the tool fails with an install hint and
nothing else is affected. Only structural types cross the boundary, so core
compiles without the package.

## What this gets over `claude_code`

`claude_code` is `execFile` on the `claude` binary with a prompt string. That is
one-shot by construction:

| | `claude_code` | `coding_agent` |
|---|---|---|
| session | none — one invocation | a real session, with an id |
| output | whatever lands on stdout at the end | streamed message chunks |
| permission requests | the child decides alone | answered by this deployment's policy |
| why it stopped | exit code | a `stopReason` from the protocol |
| cancellation | kill the process | protocol-level, plus the kill |

`claude_code` is untouched and still works. Superseding it is a separate
decision, since the two have different config and a deployment may be relying on
one of its flags.

## Permissions, and why the default is `deny`

A coding agent asks for permission at exactly the moment it is about to write a
file or run a command. So the answer to "what should we say when nobody is
watching" is the whole security posture of this tool, not a detail.

The default is **`deny`**. An unattended path — cron, a room, the task watcher —
saying yes on the owner's behalf is the failure this codebase keeps producing
(see [#545](https://github.com/quintonmiller/tailored-ai/issues/545) and the
`noHandlerAction` discussion in [defensive-patterns.md](./defensive-patterns.md)),
and a subagent is a way to get it at one remove.

A denial is not silent. The tool reports what was refused and names the key that
changes it, so the first run tells you what to do rather than returning a
mysteriously short answer:

```
[2 action(s) refused by this deployment's policy: write src/index.ts, run tests.
 Set tools.coding_agent.permissions: allow to let it act.]
```

Two details of how the answer is chosen:

- **Picked by kind, never by position.** An agent supplies its own option list
  and their ids are its own; choosing "the first option" is how a deny becomes
  an allow against an agent that orders them differently.
- **One-shot is preferred over standing, in both directions.** ACP distinguishes
  `allow_once` from `allow_always`. A standing grant is a policy decision, and
  nothing here is entitled to make one on the owner's behalf — so `allow` means
  allow *this*, and `deny` means deny *this*.

If neither kind is on offer, the answer is `cancelled`, which is the protocol's
own way of saying "no decision" and the safe reading of an unanswerable ask.

### A policy is not a sandbox

**`permissions` decides what TAI answers when it is asked. It cannot stop an
agent that does not ask.** This is not theoretical — it is what happened the
first time this was pointed at a real agent:

| agent | `permissions: deny`, told to write a file | |
|---|---|---|
| Claude Code | asked, was refused, wrote nothing | `denied: ["Write …/hello.txt"]` |
| Codex | never asked, wrote the file | `denied: []` |

Codex's own reply says why: *"Automatic approval review approved (risk: low,
authorization: unknown)."* It has an internal auto-approval that decided the
write was low-risk, so no `session/request_permission` ever reached the client
and there was nothing for the policy to answer.

So treat `permissions: deny` as **a preference expressed to a cooperating
agent**, not as containment. Real containment for an agent that acts without
asking is the boundary it cannot talk its way past:

- the agent entry's `cwd`, and the calling turn's `workingDirectoryBoundary`;
- the agent's own settings, where it has them — Codex takes
  `-c approval_policy=…` and `-c sandbox_mode=…`, which TAI passes through
  `args` without needing to understand;
- the OS, via a sandbox. Running the agent through TAI's sandbox seam is the
  durable answer and is not implemented yet
  ([#560](https://github.com/quintonmiller/tailored-ai/issues/560)).

## Verified against

Both adapters, on a real account, from this repo's client:

| | handshake | text back | `deny` + write | `allow` + write |
|---|---|---|---|---|
| `claude-code-acp` 0.16.2 | ✅ | ✅ | refused, no file | wrote the file |
| `codex-acp` 0.16.0 | ✅ | ✅ | **auto-approved, wrote the file** | wrote the file |

Round-trip for a one-word reply: ~34s for Claude Code, ~9s for Codex.

## The working directory

The session runs in the calling turn's `workingDirectoryBoundary` when it has
one, and its `workingDirectory` otherwise. A subagent that could write anywhere
would be a hole straight through a containment the parent turn is subject to.
An agent entry's own `cwd` overrides both, which is how a deployment pins one
agent to one checkout.

## What this does not do yet

- **One prompt per call.** A persistent session across tool calls is the obvious
  next step and a different design question: it needs somewhere to live across
  calls, and an answer for what happens to it when the turn ends.
- **No file-change notifications or terminal proxying.** The protocol defines
  both; core answers permission requests and reads message chunks, and ignores
  the rest.
- **Permissions come from config, not from a human.** Routing a request to
  TAI's own `ApprovalHandler` is the right end state and is blocked on the same
  gap [#545](https://github.com/quintonmiller/tailored-ai/issues/545) found:
  most paths have no approver at all. Tracked with
  [#143](https://github.com/quintonmiller/tailored-ai/issues/143).

## Being driven, rather than driving

The other half — an editor or another agent driving TAI — needs an inbound
JSON-RPC transport core does not have, and overlaps
[#178](https://github.com/quintonmiller/tailored-ai/issues/178). It is tracked
separately in [#558](https://github.com/quintonmiller/tailored-ai/issues/558)
and deliberately not started.
