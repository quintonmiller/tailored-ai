import type { WorkflowEngine } from "../workflows/engine.js";

/**
 * Generic sensor / numeric-threshold trigger. Polls any HTTP endpoint that
 * returns JSON, extracts a numeric value via a dot/bracket path, and fires
 * a workflow on rising-edge condition transitions.
 *
 * Use cases: IoT devices with a tiny HTTP server, Prometheus-style metric
 * endpoints, smart-home bridges, custom sensors. For the curated cases
 * (weather, Home Assistant, finance) use the dedicated trigger kinds —
 * this one is the escape hatch.
 */

export interface SensorTriggerConfig {
  /** URL returning a JSON document. */
  url: string;
  /**
   * Dot/bracket path to a numeric value inside the response. Supports:
   *   - "value"
   *   - "data.temperature"
   *   - "readings[0].value"
   *   - "sensors['outside'].temp"
   */
  valuePath: string;
  /** Comparison operator. */
  op: "gt" | "lt" | "gte" | "lte" | "eq";
  /** Threshold value. */
  threshold: number;
  /** Poll interval seconds. Default 60. Min 15. */
  intervalSeconds?: number;
  /** Optional request headers. */
  headers?: Record<string, string>;
}

export interface SensorPollerOptions {
  workflowEngine: WorkflowEngine;
  fetchImpl?: typeof fetch;
}

interface Registration {
  workflowName: string;
  config: SensorTriggerConfig;
  intervalSeconds: number;
  conditionLast: boolean | null;
  timer: ReturnType<typeof setInterval>;
}

const MIN_INTERVAL_SECONDS = 15;
const DEFAULT_INTERVAL_SECONDS = 60;

export class SensorPoller {
  private opts: SensorPollerOptions;
  private regs: Registration[] = [];
  private fetchImpl: typeof fetch;

  constructor(opts: SensorPollerOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  register(workflowName: string, config: SensorTriggerConfig): void {
    if (!config.url) throw new Error("sensor trigger requires url");
    if (!config.valuePath) throw new Error("sensor trigger requires valuePath");
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
    let raw: unknown;
    try {
      const res = await this.fetchImpl(reg.config.url, {
        headers: { Accept: "application/json", ...(reg.config.headers ?? {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
      const v = resolveValuePath(raw, reg.config.valuePath);
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`path "${reg.config.valuePath}" did not resolve to a finite number`);
      }
      value = v;
    } catch (err) {
      console.warn(`[sensor] poll failed for "${reg.workflowName}": ${(err as Error).message}`);
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
          value,
          path: reg.config.valuePath,
          op: reg.config.op,
          threshold: reg.config.threshold,
          url: reg.config.url,
        },
        "programmatic",
      );
    } catch (err) {
      console.warn(`[sensor] failed to fire workflow "${reg.workflowName}": ${(err as Error).message}`);
    }
  }
}

function compareNumeric(value: number, op: SensorTriggerConfig["op"], threshold: number): boolean {
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

/**
 * Resolve a dot/bracket path against a JSON value. Supports:
 *   - dot keys: a.b.c
 *   - numeric bracket indices: a[0]
 *   - quoted bracket keys: a['key with spaces'] or a["key"]
 * Returns undefined if any segment misses. Exported for unit tests.
 */
export function resolveValuePath(root: unknown, path: string): unknown {
  if (!path) return root;
  const tokens: string[] = [];
  let i = 0;
  while (i < path.length) {
    const c = path[i];
    if (c === ".") {
      i++;
      continue;
    }
    if (c === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) return undefined;
      let inner = path.slice(i + 1, close).trim();
      if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
        inner = inner.slice(1, -1);
      }
      tokens.push(inner);
      i = close + 1;
      continue;
    }
    let next = i;
    while (next < path.length && path[next] !== "." && path[next] !== "[") next++;
    tokens.push(path.slice(i, next));
    i = next;
  }
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(t);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[t];
    } else {
      return undefined;
    }
  }
  return cur;
}
