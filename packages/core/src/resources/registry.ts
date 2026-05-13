import type {
  Resource,
  ResourceEvent,
  ResourceKind,
  ResourceListener,
  ResourceRef,
} from "./interface.js";

interface VersionedSlot {
  /** Ordered list of versions; head is the active (last-registered or pinned). */
  versions: Map<string, Resource>;
  active: string;
}

/**
 * In-memory store keyed by `(kind, id) → versions`. Active version defaults to
 * the last one registered; callers can override via {@link setActiveVersion}.
 *
 * Not thread-safe (node is single-threaded for our use case). All mutation is
 * synchronous so consumers can read inside event listeners.
 */
export class ResourceRegistry {
  private slots = new Map<ResourceKind, Map<string, VersionedSlot>>();
  private listeners = new Set<ResourceListener>();

  /** Register a resource. Replaces the slot if `(kind,id,version)` already exists. */
  register(resource: Resource): void {
    const { kind, id, version } = resource.manifest;
    let byId = this.slots.get(kind);
    if (!byId) {
      byId = new Map();
      this.slots.set(kind, byId);
    }
    let slot = byId.get(id);
    const wasReplacement = !!slot?.versions.has(version);
    if (!slot) {
      slot = { versions: new Map(), active: version };
      byId.set(id, slot);
    }
    slot.versions.set(version, resource);
    slot.active = version;
    this.emit({
      type: wasReplacement ? "replaced" : "registered",
      kind,
      id,
      version,
      origin: resource.origin,
    });
  }

  /** Remove a single version, or all versions for `(kind,id)` if version omitted. */
  unregister(ref: ResourceRef): boolean {
    const byId = this.slots.get(ref.kind);
    if (!byId) return false;
    const slot = byId.get(ref.id);
    if (!slot) return false;

    if (ref.version) {
      const res = slot.versions.get(ref.version);
      if (!res) return false;
      slot.versions.delete(ref.version);
      if (slot.versions.size === 0) {
        byId.delete(ref.id);
      } else if (slot.active === ref.version) {
        const next = Array.from(slot.versions.keys()).pop()!;
        slot.active = next;
      }
      this.emit({
        type: "unregistered",
        kind: ref.kind,
        id: ref.id,
        version: ref.version,
        origin: res.origin,
      });
      return true;
    }

    // Remove the whole id.
    const versions = Array.from(slot.versions.entries());
    byId.delete(ref.id);
    for (const [version, res] of versions) {
      this.emit({
        type: "unregistered",
        kind: ref.kind,
        id: ref.id,
        version,
        origin: res.origin,
      });
    }
    return true;
  }

  /** Returns the active version for `(kind,id)`, or undefined when missing. */
  get<TBody = unknown>(ref: ResourceRef): Resource<TBody> | undefined {
    const slot = this.slots.get(ref.kind)?.get(ref.id);
    if (!slot) return undefined;
    const v = ref.version ?? slot.active;
    return slot.versions.get(v) as Resource<TBody> | undefined;
  }

  /** Pin which version of `(kind,id)` is returned by version-less `get`. */
  setActiveVersion(ref: Required<ResourceRef>): boolean {
    const slot = this.slots.get(ref.kind)?.get(ref.id);
    if (!slot || !slot.versions.has(ref.version)) return false;
    slot.active = ref.version;
    return true;
  }

  /** List all active resources, optionally filtered by kind. */
  list<TBody = unknown>(kind?: ResourceKind): Resource<TBody>[] {
    const out: Resource<TBody>[] = [];
    const kinds = kind ? [kind] : Array.from(this.slots.keys());
    for (const k of kinds) {
      const byId = this.slots.get(k);
      if (!byId) continue;
      for (const slot of byId.values()) {
        const res = slot.versions.get(slot.active);
        if (res) out.push(res as Resource<TBody>);
      }
    }
    return out;
  }

  /** List every version of every resource (handy for debug + lockfile build). */
  listAllVersions<TBody = unknown>(kind?: ResourceKind): Resource<TBody>[] {
    const out: Resource<TBody>[] = [];
    const kinds = kind ? [kind] : Array.from(this.slots.keys());
    for (const k of kinds) {
      const byId = this.slots.get(k);
      if (!byId) continue;
      for (const slot of byId.values()) {
        for (const res of slot.versions.values()) out.push(res as Resource<TBody>);
      }
    }
    return out;
  }

  /** Subscribe to register / unregister / replace events. Returns disposer. */
  on(listener: ResourceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Remove all listeners and resources — primarily for tests. */
  clear(): void {
    this.slots.clear();
    this.listeners.clear();
  }

  private emit(event: ResourceEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        // Listener errors must not break registration.
        // eslint-disable-next-line no-console
        console.error(`[resources] listener error for ${event.type} ${event.kind}:${event.id}`, err);
      }
    }
  }
}
