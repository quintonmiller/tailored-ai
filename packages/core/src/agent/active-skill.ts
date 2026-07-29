/**
 * Runtime state for the currently-active skill in the progressive-loading
 * model. The agent loop hands a fresh container into every loop run; the
 * `load_skill` tool flips `current` when a skill activates.
 *
 * Only `allowedTools` is enforced, by the loop's tool gating. See `rootPath`.
 */
export interface ActiveSkillRecord {
  /** Skill id, e.g. `pdf-processor` or `acme/widget`. */
  id: string;
  /** Subset of the host tool set the skill is permitted to call. Empty = no restriction. */
  allowedTools: string[];
  /**
   * Absolute filesystem root of the skill's bundle. Optional — built-in skills
   * authored at runtime may not have one.
   *
   * **Recorded, not enforced.** This said scoped tools "reject paths outside
   * this directory", and `load_skill` told the model it was "scoped to" this
   * path — but no tool reads it. `read` and `exec` confine against
   * `workingDirectoryBoundary` from `toolContextExtras`, which is unrelated.
   *
   * The claim was removed rather than the field: telling a model it is confined
   * when it is not is worse than saying nothing, and this is the value a real
   * enforcement would need. Enforcing it is #287.
   */
  rootPath?: string;
  /** Activation timestamp for telemetry. */
  activatedAt: number;
}

/** Mutable shared state for the active skill — passed by reference into tools. */
export interface ActiveSkillState {
  current: ActiveSkillRecord | null;
}

export function createActiveSkillState(): ActiveSkillState {
  return { current: null };
}

export function activateSkill(state: ActiveSkillState, record: Omit<ActiveSkillRecord, "activatedAt">): void {
  state.current = { ...record, activatedAt: Date.now() };
}

export function deactivateSkill(state: ActiveSkillState): void {
  state.current = null;
}
