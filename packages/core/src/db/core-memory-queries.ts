import type Database from "better-sqlite3";

/**
 * Always-injected identity layer (see docs/agent-unification.md).
 *
 * One row per (agent, project_id, section). Sections are typed by
 * convention; content is agent-authored prose. The injection layer
 * hard-caps total content per (agent, project) at ~2K tokens to keep
 * per-turn cost predictable — enforcement lives in the rendering /
 * tool layer, not here.
 */
export type CoreMemorySection =
  | "persona"
  | "active_threads"
  | "recent_summary"
  | "open_questions"
  | "user_state";

export const CORE_MEMORY_SECTIONS: CoreMemorySection[] = [
  "persona",
  "active_threads",
  "recent_summary",
  "open_questions",
  "user_state",
];

export interface CoreMemoryRow {
  id: number;
  agent: string;
  project_id: string | null;
  section: CoreMemorySection;
  content: string;
  updated_at: string;
  updated_by: string | null;
}

export interface CoreMemoryScope {
  agent: string;
  /**
   * null means "global / project-invariant" (typically used for `persona`).
   * Lookups with a specific project_id transparently fall through to the
   * global row when no project-specific override exists.
   */
  project_id: string | null;
}

/**
 * Read all sections for a scope. When project_id is set, the project's
 * own sections take precedence; global sections (project_id IS NULL)
 * fill in any gaps. Returns at most one row per section.
 */
export function getCoreMemory(
  db: Database.Database,
  scope: CoreMemoryScope,
): CoreMemoryRow[] {
  if (scope.project_id === null) {
    return db
      .prepare(
        `SELECT * FROM core_memory
         WHERE agent = ? AND project_id IS NULL
         ORDER BY section`,
      )
      .all(scope.agent) as CoreMemoryRow[];
  }

  // Project-scoped: pick project rows where they exist, otherwise global.
  // SQLite trick — partition by section, prefer non-null project_id.
  return db
    .prepare(
      `SELECT * FROM (
         SELECT *, CASE WHEN project_id IS NULL THEN 1 ELSE 0 END AS is_global
         FROM core_memory
         WHERE agent = ? AND (project_id = ? OR project_id IS NULL)
       )
       GROUP BY section
       HAVING MIN(is_global)
       ORDER BY section`,
    )
    .all(scope.agent, scope.project_id) as CoreMemoryRow[];
}

export function getCoreMemorySection(
  db: Database.Database,
  scope: CoreMemoryScope,
  section: CoreMemorySection,
): CoreMemoryRow | null {
  // Same project-then-global fallback as getCoreMemory, for one section.
  if (scope.project_id === null) {
    const row = db
      .prepare(
        `SELECT * FROM core_memory
         WHERE agent = ? AND project_id IS NULL AND section = ?`,
      )
      .get(scope.agent, section) as CoreMemoryRow | undefined;
    return row ?? null;
  }
  const project = db
    .prepare(
      `SELECT * FROM core_memory
       WHERE agent = ? AND project_id = ? AND section = ?`,
    )
    .get(scope.agent, scope.project_id, section) as CoreMemoryRow | undefined;
  if (project) return project;
  const global_ = db
    .prepare(
      `SELECT * FROM core_memory
       WHERE agent = ? AND project_id IS NULL AND section = ?`,
    )
    .get(scope.agent, section) as CoreMemoryRow | undefined;
  return global_ ?? null;
}

export interface SetCoreMemoryInput {
  agent: string;
  project_id: string | null;
  section: CoreMemorySection;
  content: string;
  updated_by?: string | null;
}

/**
 * Atomic replace of a section's content. Upserts on the unique key
 * (agent, project_id, section).
 */
export function setCoreMemory(
  db: Database.Database,
  input: SetCoreMemoryInput,
): CoreMemoryRow {
  // ON CONFLICT target must match the COALESCE-wrapped unique index in
  // schema.ts so NULL project_ids upsert correctly (SQLite considers
  // NULLs distinct in vanilla unique constraints).
  db.prepare(
    `INSERT INTO core_memory (agent, project_id, section, content, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(agent, COALESCE(project_id, ''), section) DO UPDATE SET
       content = excluded.content,
       updated_by = excluded.updated_by,
       updated_at = datetime('now')`,
  ).run(
    input.agent,
    input.project_id,
    input.section,
    input.content,
    input.updated_by ?? null,
  );
  return getCoreMemorySection(db, { agent: input.agent, project_id: input.project_id }, input.section)!;
}

export interface AppendCoreMemoryInput extends Omit<SetCoreMemoryInput, "content"> {
  item: string;
  /**
   * When true and the new content would push past `maxBytes`, the
   * oldest lines are trimmed from the head until it fits. Default
   * 4096 bytes per section.
   */
  maxBytes?: number;
}

/**
 * Append `item` as a new line to a list-shaped section
 * (`active_threads`, `recent_summary`, `open_questions`). Trims from
 * the head when the section exceeds maxBytes — keeps the most recent
 * content. Returns the resulting row.
 */
export function appendCoreMemory(
  db: Database.Database,
  input: AppendCoreMemoryInput,
): CoreMemoryRow {
  const existing = getCoreMemorySection(
    db,
    { agent: input.agent, project_id: input.project_id },
    input.section,
  );
  const existingContent = existing?.content ?? "";
  const max = input.maxBytes ?? 4096;
  let next = existingContent ? `${existingContent}\n${input.item}` : input.item;
  if (next.length > max) {
    // Trim head one line at a time until under the cap.
    const lines = next.split("\n");
    while (lines.length > 1 && lines.join("\n").length > max) {
      lines.shift();
    }
    next = lines.join("\n");
  }
  return setCoreMemory(db, {
    agent: input.agent,
    project_id: input.project_id,
    section: input.section,
    content: next,
    updated_by: input.updated_by,
  });
}

/**
 * Remove a line matching `match` (exact or substring) from a section.
 * Returns the updated row, or null when the section doesn't exist.
 */
export function removeCoreMemoryLine(
  db: Database.Database,
  scope: CoreMemoryScope,
  section: CoreMemorySection,
  match: string,
  options: { exact?: boolean; updated_by?: string | null } = {},
): CoreMemoryRow | null {
  const existing = getCoreMemorySection(db, scope, section);
  if (!existing) return null;
  const lines = existing.content.split("\n");
  const keep = lines.filter((line) =>
    options.exact ? line !== match : !line.includes(match),
  );
  if (keep.length === lines.length) return existing; // no change
  return setCoreMemory(db, {
    agent: scope.agent,
    project_id: scope.project_id,
    section,
    content: keep.join("\n"),
    updated_by: options.updated_by ?? null,
  });
}

export function clearCoreMemorySection(
  db: Database.Database,
  scope: CoreMemoryScope,
  section: CoreMemorySection,
): boolean {
  const res = db
    .prepare(
      `DELETE FROM core_memory
       WHERE agent = ? AND project_id IS ? AND section = ?`,
    )
    .run(scope.agent, scope.project_id, section);
  return res.changes > 0;
}

/**
 * Format a scope's core memory as a single string ready for prompt
 * injection. Sections appear in a stable order; empty sections are
 * omitted. The output is bounded by `maxBytes` (default 8192) —
 * earlier sections win when the budget runs out.
 */
export function renderCoreMemory(
  rows: CoreMemoryRow[],
  options: { maxBytes?: number } = {},
): string {
  const max = options.maxBytes ?? 8192;
  const order: CoreMemorySection[] = [
    "persona",
    "user_state",
    "active_threads",
    "recent_summary",
    "open_questions",
  ];
  const bySection = new Map(rows.map((r) => [r.section, r]));
  const parts: string[] = [];
  let used = 0;
  for (const section of order) {
    const row = bySection.get(section);
    if (!row || !row.content.trim()) continue;
    const block = `## ${section}\n${row.content.trim()}\n`;
    if (used + block.length > max) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n");
}
