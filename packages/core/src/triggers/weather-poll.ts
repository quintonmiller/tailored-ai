import type { WorkflowEngine } from "../workflows/engine.js";

/**
 * Polls Open-Meteo's free forecast API for a location and fires a workflow
 * when a chosen field crosses a threshold. Uses rising-edge dedup so the
 * workflow runs once per condition entry rather than on every poll.
 *
 * Open-Meteo requires no API key. See https://open-meteo.com/en/docs
 *
 * Default field is `temperature_2m` (current temperature in Celsius). Other
 * usable fields from `current_weather` and `current` blocks of the response
 * are passed through transparently — the poller looks them up by name in
 * the response payload.
 */

export interface WeatherTriggerConfig {
  /** Latitude in decimal degrees. */
  lat: number;
  /** Longitude in decimal degrees. */
  lng: number;
  /**
   * Field to read from the Open-Meteo response. Looked up against the
   * `current` block (e.g. `temperature_2m`, `precipitation`, `windspeed_10m`,
   * `relative_humidity_2m`, `apparent_temperature`).
   */
  field: string;
  /** Comparison operator. */
  op: "gt" | "lt" | "gte" | "lte" | "eq";
  /** Threshold value. */
  threshold: number;
  /** Poll interval seconds. Default 1800 (30 min). Min 600. */
  intervalSeconds?: number;
  /** Override the API base URL. Defaults to https://api.open-meteo.com/v1/forecast */
  apiBaseUrl?: string;
}

export interface WeatherPollerOptions {
  workflowEngine: WorkflowEngine;
  fetchImpl?: typeof fetch;
}

interface Registration {
  workflowName: string;
  config: WeatherTriggerConfig;
  intervalSeconds: number;
  conditionLast: boolean | null;
  timer: ReturnType<typeof setInterval>;
}

const MIN_INTERVAL_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 1800;
const DEFAULT_API_BASE = "https://api.open-meteo.com/v1/forecast";

export class WeatherPoller {
  private opts: WeatherPollerOptions;
  private regs: Registration[] = [];
  private fetchImpl: typeof fetch;

  constructor(opts: WeatherPollerOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  register(workflowName: string, config: WeatherTriggerConfig): void {
    if (typeof config.lat !== "number" || typeof config.lng !== "number") {
      throw new Error("weather trigger requires numeric lat and lng");
    }
    if (!config.field) throw new Error("weather trigger requires field");
    const interval = Math.max(config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS);
    const reg: Registration = {
      workflowName,
      config,
      intervalSeconds: interval,
      conditionLast: null,
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
    let value: number;
    let units: string | undefined;
    let time: string | undefined;
    try {
      const base = reg.config.apiBaseUrl ?? DEFAULT_API_BASE;
      const url = `${base}?latitude=${reg.config.lat}&longitude=${reg.config.lng}&current=${encodeURIComponent(reg.config.field)}`;
      const res = await this.fetchImpl(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        current?: Record<string, number | string>;
        current_units?: Record<string, string>;
      };
      const v = body.current?.[reg.config.field];
      if (typeof v !== "number") throw new Error(`field "${reg.config.field}" missing or not numeric in response`);
      value = v;
      units = body.current_units?.[reg.config.field];
      const t = body.current?.time;
      time = typeof t === "string" ? t : undefined;
    } catch (err) {
      console.warn(`[weather] fetch failed for "${reg.workflowName}": ${(err as Error).message}`);
      return;
    }

    const condition = compareNumeric(value, reg.config.op, reg.config.threshold);

    if (reg.conditionLast === null) {
      reg.conditionLast = condition;
      return;
    }
    if (reg.conditionLast === condition || !condition) {
      reg.conditionLast = condition;
      return;
    }
    reg.conditionLast = condition;

    try {
      await this.opts.workflowEngine.runWorkflow(
        reg.workflowName,
        {
          field: reg.config.field,
          value,
          units,
          op: reg.config.op,
          threshold: reg.config.threshold,
          observed_at: time,
          lat: reg.config.lat,
          lng: reg.config.lng,
        },
        "programmatic",
      );
    } catch (err) {
      console.warn(`[weather] failed to fire workflow "${reg.workflowName}": ${(err as Error).message}`);
    }
  }
}

export function compareNumeric(value: number, op: WeatherTriggerConfig["op"], threshold: number): boolean {
  switch (op) {
    case "gt":
      return value > threshold;
    case "lt":
      return value < threshold;
    case "gte":
      return value >= threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
  }
}
