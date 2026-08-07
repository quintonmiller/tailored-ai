/**
 * How a caller tells a memory backend whose memory it is asking about.
 *
 * Its own module because both sides need it — `memory-inject` builds the scope
 * and `recall-query` forwards it — and those two already import each other, so
 * putting it in either would close the cycle.
 *
 * The scope is a space-separated set of open tokens rather than a typed field:
 * `parseScope` in the SQLite backend already understood `project:`, `agent:` and
 * `session:`, and a plugin backend is free to define its own and ignore the
 * rest. Adding agent scoping therefore needed no change to the `MemoryBackend`
 * contract at all.
 */

/**
 * `global` / `project:<id>`, plus `agent:<name>` when the caller knows whose
 * turn this is.
 *
 * Omitting the agent is meaningful: it produces exactly the scope that was sent
 * before agent scoping existed, so an unnamed session keeps the cross-agent
 * view instead of silently recalling nothing.
 */
export function memoryScope(projectId: string | null, agent?: string): string {
  const base = projectId ? `project:${projectId}` : "global";
  return agent ? `${base} agent:${agent}` : base;
}
