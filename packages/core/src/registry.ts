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

  register(id: string, factory: T): void {
    if (this.entries.has(id)) {
      console.warn(
        `[${this.kind}-registry] Replacing existing entry "${id}". This is fine for plugin reloads, but unexpected at startup may indicate a duplicate registration.`,
      );
    }
    this.entries.set(id, factory);
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
