/**
 * Runtime state for the currently-active skill in the progressive-loading
 * model. The agent loop hands a fresh container into every loop run; the
 * `load_skill` tool flips `current` when a skill activates, and tools (read,
 * exec, the loop's tool gating) read from it.
 */
export interface ActiveSkillRecord {
  /** Skill id, e.g. `pdf-processor` or `acme/widget`. */
  id: string;
  /** Subset of the host tool set the skill is permitted to call. Empty = no restriction. */
  allowedTools: string[];
  /**
   * Absolute filesystem root of the skill's bundle. When set, scoped tools
   * (read/exec) reject paths outside this directory. Optional — built-in
   * skills authored at runtime may not have a rootPath.
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
