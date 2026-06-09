import type { Resource, ResourceManifest, ResourceOrigin } from "./interface.js";
import { ResourceRegistry } from "./registry.js";

/**
 * Metadata describing a workflow trigger kind (the string that goes in a
 * workflow's `triggers[].kind` field). The registry catalogs which kinds are
 * available so UIs / validators can enumerate them and so community-authored
 * trigger plugins can be discovered.
 *
 * The actual scheduling/polling implementation still lives in the runtime
 * subsystem that handles the kind (CronScheduler for "cron",
 * FileDropWatcher for "file_drop", etc.). Splitting *catalog* from *runner*
 * keeps this S8.4 slice small while still surfacing the trigger surface for
 * tooling.
 */
export interface TriggerKindMeta {
  /** Kind string as it appears in workflow YAML (e.g. "cron", "webhook"). */
  kind: string;
  /** Short, user-facing description. */
  description?: string;
  /** Loose JSON schema describing the trigger config block. Used by UIs/validation. */
  configSchema?: Record<string, unknown>;
  /** When true, this trigger fires asynchronously (poller/watcher rather than per-request). */
  async?: boolean;
}

export class TriggerKindRegistry {
  constructor(private readonly resources: ResourceRegistry = new ResourceRegistry()) {}

  asResources(): ResourceRegistry {
    return this.resources;
  }

  registerBuiltin(meta: TriggerKindMeta, opts: { version?: string } = {}): void {
    const manifest: ResourceManifest = {
      kind: "trigger",
      id: `builtin/${meta.kind}`,
      version: opts.version ?? "0.0.0",
      description: meta.description,
      data: { kind: meta.kind, configSchema: meta.configSchema ?? null, async: meta.async ?? false },
    };
    const origin: ResourceOrigin = {
      scheme: "file",
      uri: `builtin:trigger/${meta.kind}`,
      loadedAt: Date.now(),
    };
    this.resources.register({ manifest, origin, body: meta });
  }

  register(resource: Resource<TriggerKindMeta>): void {
    if (resource.manifest.kind !== "trigger") {
      throw new Error(`expected manifest.kind="trigger", got "${resource.manifest.kind}"`);
    }
    this.resources.register(resource);
  }

  unregister(id: string, version?: string): boolean {
    return this.resources.unregister({ kind: "trigger", id, version });
  }

  /** Look up metadata by trigger kind string. */
  getByKind(kind: string): TriggerKindMeta | undefined {
    for (const r of this.resources.list<TriggerKindMeta>("trigger")) {
      if (r.body?.kind === kind) return r.body;
    }
    return undefined;
  }

  list(): TriggerKindMeta[] {
    return this.resources
      .list<TriggerKindMeta>("trigger")
      .map((r) => r.body)
      .filter((m): m is TriggerKindMeta => !!m);
  }
}

/** The set of trigger kinds the runtime ships with today. */
export const BUILTIN_TRIGGER_KINDS: TriggerKindMeta[] = [
  { kind: "manual", description: "User-initiated run via CLI / UI / API." },
  { kind: "cron", description: "Schedule by cron expression.", async: true },
  { kind: "webhook", description: "HTTP POST to /api/workflows/:name/webhook." },
  { kind: "tool_called", description: "Fires when a specific tool is invoked." },
  { kind: "document_event", description: "Fires on document create / update / delete." },
  { kind: "config_event", description: "Fires when the agent config is reloaded." },
  { kind: "file_drop", description: "Watches a directory and fires per added file.", async: true },
  { kind: "fs_watch", description: "Watches paths/globs and fires on create/modify/delete.", async: true },
  { kind: "email_message", description: "Polls a Gmail account for matching messages.", async: true },
  { kind: "calendar_event", description: "Fires N minutes before a calendar event.", async: true },
  { kind: "rss", description: "Polls an RSS/Atom feed for new entries.", async: true },
  { kind: "geofence", description: "Polls a location URL and fires on geofence boundary crossings.", async: true },
  { kind: "weather", description: "Polls Open-Meteo for a threshold-crossing weather condition.", async: true },
  { kind: "sensor", description: "Polls a generic JSON endpoint for a numeric threshold cross.", async: true },
  { kind: "finance", description: "Polls a stock/forex quote provider for a price cross.", async: true },
  { kind: "home_assistant", description: "Polls a Home Assistant entity for state changes.", async: true },
];

/** Convenience helper: populate the registry with every built-in. */
export function populateBuiltinTriggers(registry: TriggerKindRegistry): void {
  for (const meta of BUILTIN_TRIGGER_KINDS) {
    registry.registerBuiltin(meta);
  }
}
