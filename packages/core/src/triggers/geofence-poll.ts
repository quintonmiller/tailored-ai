import type { WorkflowEngine } from "../workflows/engine.js";

/**
 * Polls a user-configured location URL and fires a workflow when the device
 * crosses a geofence boundary (enter, exit, or both). Designed for a phone
 * companion app that POSTs `{lat, lng}` to a small HTTP endpoint the user
 * owns; the poller GETs the same endpoint on an interval.
 *
 * Rising-edge fire only — the workflow runs once per transition, not on
 * every poll while the device is inside the fence.
 */

export interface GeofenceTriggerConfig {
  /** URL returning `{lat: number, lng: number, accuracy?: number}` as JSON. */
  locationUrl: string;
  /** Center of the fence in decimal degrees. */
  center: { lat: number; lng: number };
  /** Radius in meters. */
  radiusMeters: number;
  /** Which transitions should fire the workflow. Default `both`. */
  direction?: "enter" | "exit" | "both";
  /** Poll interval seconds. Default 60. Minimum 30. */
  intervalSeconds?: number;
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  authToken?: string;
}

export interface GeofencePollerOptions {
  workflowEngine: WorkflowEngine;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Registration {
  workflowName: string;
  config: GeofenceTriggerConfig;
  intervalSeconds: number;
  insideLast: boolean | null;
  timer: ReturnType<typeof setInterval>;
}

const MIN_INTERVAL_SECONDS = 30;
const DEFAULT_INTERVAL_SECONDS = 60;

export class GeofencePoller {
  private opts: GeofencePollerOptions;
  private regs: Registration[] = [];
  private fetchImpl: typeof fetch;

  constructor(opts: GeofencePollerOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  register(workflowName: string, config: GeofenceTriggerConfig): void {
    if (!config.locationUrl) throw new Error("geofence trigger requires locationUrl");
    if (config.radiusMeters <= 0) throw new Error("geofence radiusMeters must be > 0");
    const interval = Math.max(config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS);
    const reg: Registration = {
      workflowName,
      config,
      intervalSeconds: interval,
      insideLast: null,
      timer: setInterval(() => this.poll(reg).catch(() => undefined), interval * 1000),
    };
    this.regs.push(reg);
  }

  stop(): void {
    for (const r of this.regs) clearInterval(r.timer);
    this.regs = [];
  }

  size(): number {
    return this.regs.length;
  }

  private async poll(reg: Registration): Promise<void> {
    let loc: { lat: number; lng: number; accuracy?: number };
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (reg.config.authToken) headers.Authorization = `Bearer ${reg.config.authToken}`;
      const res = await this.fetchImpl(reg.config.locationUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      loc = (await res.json()) as typeof loc;
    } catch (err) {
      console.warn(`[geofence] fetch failed for "${reg.workflowName}": ${(err as Error).message}`);
      return;
    }
    if (typeof loc?.lat !== "number" || typeof loc?.lng !== "number") {
      console.warn(`[geofence] bad payload for "${reg.workflowName}": missing lat/lng`);
      return;
    }
    const distance = haversineMeters(reg.config.center, loc);
    const inside = distance <= reg.config.radiusMeters;
    const direction = reg.config.direction ?? "both";

    if (reg.insideLast === null) {
      // First poll — prime without firing.
      reg.insideLast = inside;
      return;
    }
    if (reg.insideLast === inside) return;

    const transition: "enter" | "exit" = inside ? "enter" : "exit";
    reg.insideLast = inside;

    if (direction !== "both" && direction !== transition) return;

    try {
      await this.opts.workflowEngine.runWorkflow(
        reg.workflowName,
        {
          transition,
          lat: loc.lat,
          lng: loc.lng,
          accuracy: loc.accuracy,
          distance_meters: Math.round(distance),
          center_lat: reg.config.center.lat,
          center_lng: reg.config.center.lng,
          radius_meters: reg.config.radiusMeters,
        },
        "programmatic",
      );
    } catch (err) {
      console.warn(
        `[geofence] failed to fire workflow "${reg.workflowName}" on ${transition}: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Great-circle distance between two lat/lng points in meters. Standard
 * haversine; accurate to <0.5% over distances up to a few hundred km.
 * Exported for unit tests.
 */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
