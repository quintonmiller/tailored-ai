export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  /**
   * Hard sandbox root — when set, file/exec tools reject paths that resolve
   * outside this directory. Distinct from `workingDirectory` (which is just
   * the default cwd for relative paths): the boundary is enforcement, the
   * cwd is convenience. task-watcher sets this to the agent's worktree path
   * for coder/reviewer dispatches so absolute paths can't escape the
   * worktree and pollute main (Phase 6 follow-up: main-pollution incident).
   * Leave unset for agents that legitimately need to read across the
   * filesystem (default, researcher, etc.).
   */
  workingDirectoryBoundary?: string;
  /**
   * Command rules declared by the agent currently running, combined with the
   * deployment's by `exec` per `tools.exec.mode`. Set from
   * `agents.<name>.exec` by `AgentRuntime.buildLoopOptions`.
   *
   * Lives on the context rather than on the tool because one ExecTool instance
   * is shared by every agent — the same reason `workingDirectoryBoundary` is
   * here. Applies to the `exec` tool only; `custom_tools` run a fixed command
   * and never consult it.
   */
  execRules?: import("./command-allowlist.js").CommandRules;
  env: Record<string, string>;
  agentContextDir?: string;
  kbDir?: string;
  agentKbDir?: string;
  approvalHandler?: import("../approval.js").ApprovalHandler;
  permissions?: import("../approval.js").PermissionsConfig;
  /** When set, the tool is executing inside the autopilot worker for this project task. */
  autopilotTaskId?: string;
  /** When set, the tool is executing inside an ExploratoryWorker tick. The id matches `exploratory_runs.id`. */
  exploratoryRunId?: string;
  /** Name of the agent currently running. Used as the author on tool-initiated records (comments, etc.). */
  agentName?: string;
  db?: import("better-sqlite3").Database;
  /** Sandbox handle to route shell/file operations through. When unset, tools execute on the host. */
  sandbox?: import("../sandboxes/interface.js").Sandbox;
  sandboxHandle?: import("../sandboxes/interface.js").SandboxHandle;
  /**
   * Mutable container used by progressive skill loading. The `load_skill`
   * tool writes into `current` when a skill activates; the agent loop reads
   * it to enforce per-skill tool allowlists. Tools that care about scope
   * (read, exec) can inspect this too.
   */
  activeSkill?: import("../agent/active-skill.js").ActiveSkillState;
  /**
   * Per-loop scratch shared across tool calls within a single agent run.
   * Cleared when the loop ends. Use for "I'll stash this so the next tool
   * call can pick it up" patterns. Distinct from notes (durable) and from
   * conversation history (visible to the model).
   */
  workingMemory?: Map<string, string>;
  /**
   * Project the loop is running against, when known. Memory injection and
   * project-scoped tool reads use this. Mirrors session.projectId.
   */
  projectId?: string | null;
  /**
   * How many characters of this call's output will survive into the
   * conversation — the same number `capToolOutput` would cut at, resolved for
   * this tool. `0` means capping is off.
   *
   * For a tool that can serve part of its result and say how to get the rest,
   * shaping the output to fit beats being truncated afterwards. Middle-out
   * truncation is a dead end by construction: it is deterministic, so the
   * obvious recovery — call again, or read the saved copy — returns a
   * byte-identical string, and the elided middle is unreachable (#466). A tool
   * that pages can hand back a whole prefix and name the next offset instead.
   *
   * Advisory. The cap still runs on whatever comes back, so ignoring this is
   * safe; it just costs the caller the elided middle.
   */
  maxOutputChars?: number;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  /**
   * End the agent's turn as soon as this call returns, without another model
   * round-trip.
   *
   * For a tool whose whole meaning is "I am done" — Sleep concluding a tick,
   * `room(action="pass")` declining to speak — the alternative is asking the
   * model to stop in the tool result, and small models routinely ignore that.
   * They call the tool again, and again, until the repeated-call detector fires
   * three round-trips later, having re-sent the whole prompt each time and
   * exited as a stall rather than as the deliberate stop it was.
   *
   * Set by the tool rather than declared on it because a multi-action tool ends
   * the turn on some actions and not others: `room` post and read continue,
   * `room` pass does not.
   */
  endsTurn?: boolean;
  /**
   * What the loop returns when `endsTurn` is set. Unset falls back to whatever
   * text the model produced alongside the call, which for a tool that means
   * "nothing to say" is usually empty — the right answer.
   */
  endsTurnReason?: string;
}

/**
 * What a call does to the world, as the tool itself understands it.
 *
 * `read` observes. `write` changes something that can be changed back.
 * `irreversible` cannot be undone by another call — a delete, a send, a
 * payment.
 *
 * Declared by the tool rather than configured by the operator, because the
 * operator does not necessarily know: installing a plugin adds tools whose
 * behaviour is not in the config file, and `permissions.defaultMode` is
 * `"auto"`, so an undeclared tool runs unattended whatever it does.
 */
export type ToolEffect = "read" | "write" | "irreversible";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;

  /**
   * What this call does, for the loop's safety checks. Omit for `read`.
   *
   * A function rather than only a constant because for the tools that matter
   * the answer depends on the arguments: `exec` running `git status` and
   * `exec` running `rm -rf` are not the same act, and charging every shell
   * call the cost of the irreversible path would make the check unaffordable
   * where it is least needed.
   */
  effect?: ToolEffect | ((args: Record<string, unknown>) => ToolEffect);

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /** Optional cleanup hook called when the tool is being replaced (e.g. on config reload). */
  destroy?(): Promise<void>;
}
