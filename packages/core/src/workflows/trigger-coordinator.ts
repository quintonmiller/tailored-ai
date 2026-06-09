/**
 * Coordinates the async-trigger pollers (file_drop, email, calendar, rss,
 * geofence, weather, sensor, finance, home_assistant) against the live
 * workflow registry. Closes #65: previously the pollers were wired once
 * at CLI startup and never reconciled on workflow add / update / remove,
 * so hot-reloading a workflow file would leave pollers either missing
 * (new workflow) or stale (deleted workflow still polling).
 *
 * The coordinator listens to `WorkflowRegistry.onChange`, walks the
 * current workflow list on each tick, computes a per-workflow trigger
 * signature, and:
 *   - unregisters triggers for workflows that disappeared
 *   - re-registers triggers for workflows whose signature changed
 *   - skips workflows whose triggers match the last seen signature
 *     (no duplicate timers)
 *
 * The pollers themselves are passed in — they're created and disposed by
 * the caller. This keeps the coordinator agnostic to dependency wiring
 * (e.g. EmailPoller needs `getTools()`) and lets tests inject fakes.
 */

import type { CalendarPoller } from "../triggers/calendar-poll.js";
import type { EmailPoller } from "../triggers/email-poll.js";
import type { FileDropWatcher } from "../triggers/file-drop.js";
import type { FsWatcher } from "../triggers/fs-watch.js";
import type { FinancePoller } from "../triggers/finance-poll.js";
import type { GeofencePoller } from "../triggers/geofence-poll.js";
import type { HomeAssistantPoller } from "../triggers/home-assistant-poll.js";
import type { RssPoller } from "../triggers/rss-poll.js";
import type { SensorPoller } from "../triggers/sensor-poll.js";
import type { WeatherPoller } from "../triggers/weather-poll.js";
import type { WorkflowRegistry } from "./registry.js";
import type { WorkflowTriggerDef } from "./types.js";

export interface WorkflowTriggerCoordinatorPollers {
  fileDrop: Pick<FileDropWatcher, "register" | "unregister">;
  fsWatch: Pick<FsWatcher, "register" | "unregister">;
  email: Pick<EmailPoller, "register" | "unregister">;
  calendar: Pick<CalendarPoller, "register" | "unregister">;
  rss: Pick<RssPoller, "register" | "unregister">;
  geofence: Pick<GeofencePoller, "register" | "unregister">;
  weather: Pick<WeatherPoller, "register" | "unregister">;
  sensor: Pick<SensorPoller, "register" | "unregister">;
  finance: Pick<FinancePoller, "register" | "unregister">;
  homeAssistant: Pick<HomeAssistantPoller, "register" | "unregister">;
}

/** Trigger kinds the coordinator dispatches; anything else (cron, manual,
 *  webhook, tool_called, document_event, config_event) is handled
 *  elsewhere. */
const POLLER_KINDS = new Set([
  "file_drop",
  "fs_watch",
  "email_message",
  "calendar_event",
  "rss",
  "geofence",
  "weather",
  "sensor",
  "finance",
  "home_assistant",
]);

export class WorkflowTriggerCoordinator {
  /** workflowName → JSON signature of its pollable triggers. */
  private signatures = new Map<string, string>();
  private unsubscribe?: () => void;

  constructor(private readonly pollers: WorkflowTriggerCoordinatorPollers) {}

  /**
   * Walk the workflow registry, dispatch triggers to the right pollers,
   * unregister triggers for missing or changed workflows. Idempotent —
   * safe to call repeatedly with the same workflow set.
   */
  reconcile(registry: WorkflowRegistry): void {
    const current = new Map<string, WorkflowTriggerDef[]>();
    for (const wf of registry.list()) {
      const pollable = (wf.definition.triggers ?? []).filter((t) => POLLER_KINDS.has(t.kind as string));
      if (pollable.length > 0) current.set(wf.definition.name, pollable);
    }

    // 1. Unregister workflows that disappeared OR whose triggers changed.
    for (const [name, lastSig] of [...this.signatures.entries()]) {
      const wantTriggers = current.get(name);
      const wantSig = wantTriggers ? JSON.stringify(wantTriggers) : undefined;
      if (!wantTriggers || wantSig !== lastSig) {
        this.unregisterAll(name);
        this.signatures.delete(name);
      }
    }

    // 2. Register workflows that are new or whose triggers just changed.
    for (const [name, triggers] of current.entries()) {
      if (this.signatures.has(name)) continue;
      for (const trig of triggers) {
        try {
          this.dispatch(name, trig);
        } catch (err) {
          console.warn(`[trigger-coordinator] ${trig.kind} register failed for "${name}": ${(err as Error).message}`);
        }
      }
      this.signatures.set(name, JSON.stringify(triggers));
    }
  }

  /**
   * Auto-reconcile on every workflow registry change. Call once during
   * runServer setup; the returned function detaches the listener.
   */
  start(registry: WorkflowRegistry): () => void {
    this.reconcile(registry);
    const cb = () => this.reconcile(registry);
    registry.onChange(cb);
    // WorkflowRegistry doesn't expose unsubscribe today, so just remember
    // we started — stopAll() drops our state.
    this.unsubscribe = () => {
      this.signatures.clear();
    };
    return this.unsubscribe;
  }

  /** Disconnect every workflow's pollers; for shutdown. */
  stopAll(): void {
    for (const name of this.signatures.keys()) this.unregisterAll(name);
    this.signatures.clear();
    this.unsubscribe?.();
  }

  /** Visible to tests. */
  list(): string[] {
    return [...this.signatures.keys()];
  }

  private unregisterAll(workflowName: string): void {
    this.pollers.fileDrop.unregister(workflowName);
    this.pollers.fsWatch.unregister(workflowName);
    this.pollers.email.unregister(workflowName);
    this.pollers.calendar.unregister(workflowName);
    this.pollers.rss.unregister(workflowName);
    this.pollers.geofence.unregister(workflowName);
    this.pollers.weather.unregister(workflowName);
    this.pollers.sensor.unregister(workflowName);
    this.pollers.finance.unregister(workflowName);
    this.pollers.homeAssistant.unregister(workflowName);
  }

  private dispatch(name: string, trig: WorkflowTriggerDef): void {
    switch (trig.kind) {
      case "file_drop":
        this.pollers.fileDrop.register(name, trig);
        break;
      case "fs_watch":
        this.pollers.fsWatch.register(name, trig);
        break;
      case "email_message":
        this.pollers.email.register(name, trig.query, trig.intervalSeconds);
        break;
      case "calendar_event":
        this.pollers.calendar.register(name, trig);
        break;
      case "rss":
        this.pollers.rss.register(name, trig);
        break;
      case "geofence":
        this.pollers.geofence.register(name, trig);
        break;
      case "weather":
        this.pollers.weather.register(name, trig);
        break;
      case "sensor":
        this.pollers.sensor.register(name, trig);
        break;
      case "finance":
        this.pollers.finance.register(name, trig);
        break;
      case "home_assistant":
        this.pollers.homeAssistant.register(name, trig);
        break;
    }
  }
}
