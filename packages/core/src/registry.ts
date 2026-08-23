/**
 * The inverse of a registration.
 *
 * Every `register` in core returns one. A caller that ignores it keeps the
 * old behaviour; a caller that owns a lifecycle — the plugin loader, a test,
 * a subsystem that re-registers on reload — calls it to take the registration
 * back out. Idempotent: calling it twice is a no-op, and it never removes an
 * entry some later registration replaced.
 */
export type Disposer = () => void;

/**
 * Thin string-keyed factory registry. Used by the provider, embedding,
 * task-backend, and channel factories so third-party packages can register
 * implementations without forking the monorepo.
 *
 * Distinct from ResourceRegistry (resources/registry.ts), which is the heavier
 * versioned resource-discovery surface used for tools, agents, skills, kb,
 * triggers, and step executors. Use ResourceRegistry when you need version
 * tracking, manifests, hot-reload events. Use Registry<T> for plain
 * "name -> factory" lookups at runtime startup.
 */
export class Registry<T> {
  private entries = new Map<string, T>();

  constructor(private readonly kind: string) {}

  /**
   * Add an entry and hand back the inverse.
   *
   * The disposer removes **only the entry this call made**: if someone
   * re-registered the same id afterwards, that entry belongs to them and
   * disposing ours must not take it away. Without that identity check a
   * plugin's teardown silently deletes a live registration it never owned,
   * which is the same class of bug as the leaked listeners in #58 — invisible
   * until something that should work stops working.
   *
   * Calling the disposer more than once is a no-op.
   */
  register(id: string, factory: T): Disposer {
    if (this.entries.has(id)) {
      console.warn(
        `[${this.kind}-registry] Replacing existing entry "${id}". This is fine for plugin reloads, but unexpected at startup may indicate a duplicate registration.`,
      );
    }
    this.entries.set(id, factory);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.entries.get(id) === factory) this.entries.delete(id);
    };
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): string[] {
    return Array.from(this.entries.keys());
  }

  entriesList(): Array<[string, T]> {
    return Array.from(this.entries.entries());
  }

  clear(): void {
    this.entries.clear();
  }
}
