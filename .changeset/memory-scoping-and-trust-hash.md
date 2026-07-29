---
"@tailored-ai/core": patch
---

fix: memory scoping, manifest hashing, and task-dispatch context (#281–#284)

Four fixes from the 2026-07-28 audit, all in the same family — something that
looked like a guard and was not.

- **`hashManifest` covered almost nothing.** `JSON.stringify(rest, Object.keys(rest).sort())`
  passes a *replacer array*, not a sort order, and it applies at every depth —
  so every manifest canonicalized to `{"data":{},…}`. Two skills differing in
  both instructions and `allowed-tools` hashed identically, which made the trust
  store's cached-approval check and `--frozen` ineffective for skills, prompts,
  kb and agents. Now canonicalized properly. **Expect one re-approval per
  installed resource** — stored hashes were computed under the old scheme.
- **`memory` no longer falls back to the global context directory.** A "profile"
  write from a session with no agent directory — un-named CLI, Slack, API — went
  to `global/`, which is injected into every agent's prompt. It now goes to a
  sibling `unscoped/` directory that nothing injects, and the result says so
  rather than calling it "profile". A redirect, not a gate: hard-failing an
  omitted optional parameter turns a quiet correctness bug into a loud stall.
- **A global-scope memory write is now logged**, naming the agent. It is still
  allowed — whether an agent may curate shared knowledge is a permissions
  question, not something to hardcode — but it changes every agent's prompt and
  used to happen silently.
- **`task-watcher` merges `toolContextExtras` instead of replacing it.** Both
  branches discarded the object `buildLoopOptions` builds, so every task
  dispatch lost `agentName`, and non-worktree dispatches lost the agent's
  declared `fileBoundary` too.

Adds the first unit coverage for `MemoryTool`, which had none despite having the
widest blast radius in the prompt path.
