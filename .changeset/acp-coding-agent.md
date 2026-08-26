---
"@tailored-ai/core": patch
---

Drive another coding agent over a real session, not a subprocess call.

`claude_code` shells out to the `claude` binary with a prompt string. That is
one-shot by construction: no session to continue, nothing streaming back while
it works, no way to answer a permission prompt, no way to know why it stopped.
Every one of those is something the Agent Client Protocol defines and a
subprocess call cannot carry.

The new `coding_agent` tool speaks ACP. It opens a session, sends the prompt,
reads the streamed message chunks, answers permission requests according to
policy, and reports the protocol's stop reason.

In core rather than in a plugin for the reason `mcp/` is: a protocol-level
capability, the `openai_compatible` of agent-driving. What keeps that honest is
that **core knows the protocol and never a vendor** — no built-in agent list, no
default command, and no agent's name in `DEFAULT_CONFIG`. `tools.coding_agent.agents`
is the only thing that decides what runs, exactly as `mcp.servers` is.
`@agentclientprotocol/sdk` is an optional dependency, dynamically imported, with
only structural types crossing the boundary so core compiles without it.

**Permission requests default to `deny`.** An agent asks precisely when it is
about to write a file or run a command, and an unattended path saying yes on the
owner's behalf is the failure this codebase keeps producing — a subagent is a
way to get it at one remove. The refusal is reported in the tool result along
with the key that changes it, so a first run says what to do rather than
returning a mysteriously short answer. The answer is chosen by option *kind*
rather than position, and prefers one-shot over standing in both directions: a
standing grant is a policy decision and nothing here is entitled to make one.

The session runs inside the calling turn's `workingDirectoryBoundary` when it
has one, so a subagent is not a hole through a containment the parent turn is
subject to.

**A policy is not a sandbox, and the docs say so.** Verified against both real
adapters: told to write a file under `permissions: deny`, Claude Code asked, was
refused and wrote nothing; Codex never asked and wrote it, having auto-approved
internally ("risk: low"). The handshake is cooperative by design — ACP lets an
agent ask, it does not oblige it to — so `deny` is a preference expressed to a
cooperating agent rather than containment. Running the agent under the sandbox
seam is the durable answer and is tracked separately.

`claude_code` is untouched. Superseding it is a separate decision.
