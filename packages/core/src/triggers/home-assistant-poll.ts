import type { WorkflowEngine } from "../workflows/engine.js";

/**
 * Polls a Home Assistant REST endpoint (`/api/states/<entity_id>`) and fires
 * a workflow when the watched entity's state matches a filter. Rising-edge
 * fire — a workflow runs once on state transition into the matched
 * condition, not on every poll while the entity sits there.
 *
 * REST polling is intentionally chosen over the websocket API for the first
 * pass: simpler, no reconnection logic, and second-scale latency is fine
 * for most "front door opened" / "garage left open 10 min" automations.
 * A push-based variant is a clean follow-up.
 */

export interface HomeAssistantTriggerConfig {
  /** Home Assistant base URL (e.g. `http://homeassistant.local:8123`). */
  baseUrl: string;
  /** Long-lived access token from HA → Profile → Security → Create Token. */
  token: string;
  /** Entity to watch (e.g. `binary_sensor.front_door`, `sensor.living_room_temperature`). */
  entityId: string;
  /**
   * One of three match modes:
   *   - `stateEquals`: fire when `.state === value`
   *   - `numericAbove`: fire when `parseFloat(.state) > value`
   *   - `numericBelow`: fire when `parseFloat(.state) < value`
   *   - `onAnyChange: true`: fire on every state change
   */
  stateEquals?: string;
  numericAbove?: number;
  numericBelow?: number;
  onAnyChange?: boolean;
  /** Poll interval seconds. Default 30. Min 10. */
  intervalSeconds?: number;
}

export interface HomeAssistantPollerOptions {
  workflowEngine: WorkflowEngine;
  fetchImpl?: typeof fetch;
}

interface Registration {
  workflowName: string;
  config: HomeAssistantTriggerConfig;
  intervalSeconds: number;
  /** Last raw .state observed, for onAnyChange dedup. */
  lastRawState: string | null;
  /** Last condition (matched filter), for rising-edge dedup. */
  conditionLast: boolean | null;
  timer: ReturnType<typeof setInterval>;
}

interface HAState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

const MIN_INTERVAL_SECONDS = 10;
const DEFAULT_INTERVAL_SECONDS = 30;

export class HomeAssistantPoller {
  private opts: HomeAssistantPollerOptions;
  private regs: Registration[] = [];
  private fetchImpl: typeof fetch;

  constructor(opts: HomeAssistantPollerOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  register(workflowName: string, config: HomeAssistantTriggerConfig): void {
    if (!config.baseUrl) throw new Error("home_assistant trigger requires baseUrl");
    if (!config.token) throw new Error("home_assistant trigger requires token");
    if (!config.entityId) throw new Error("home_assistant trigger requires entityId");
    const matchModes = [
      config.stateEquals !== undefined,
      config.numericAbove !== undefined,
      config.numericBelow !== undefined,
      config.onAnyChange === true,
    ].filter(Boolean).length;
    if (matchModes === 0) {
      throw new Error("home_assistant trigger requires one of stateEquals / numericAbove / numericBelow / onAnyChange");
    }
    if (matchModes > 1) {
      throw new Error("home_assistant trigger: pick exactly one of stateEquals / numericAbove / numericBelow / onAnyChange");
    }
    const interval = Math.max(config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS);
    const reg: Registration = {
      workflowName,
      config,
      intervalSeconds: interval,
      lastRawState: null,
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
    let body: HAState;
    try {
      const url = `${reg.config.baseUrl.replace(/\/$/, "")}/api/states/${encodeURIComponent(reg.config.entityId)}`;
      const res = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${reg.config.token}`,
          Accept: "application/json",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as HAState;
    } catch (err) {
      console.warn(
        `[home_assistant] poll failed for "${reg.workflowName}" (${reg.config.entityId}): ${(err as Error).message}`,
      );
      return;
    }

    if (reg.config.onAnyChange) {
      if (reg.lastRawState === null) {
        reg.lastRawState = body.state;
        return;
      }
      if (reg.lastRawState === body.state) return;
      const previous = reg.lastRawState;
      reg.lastRawState = body.state;
      await this.fire(reg, body, { previous_state: previous });
      return;
    }

    const condition = matchesCondition(body.state, reg.config);
    if (reg.conditionLast === null) {
      reg.conditionLast = condition;
      return;
    }
    if (reg.conditionLast === condition || !condition) {
      reg.conditionLast = condition;
      return;
    }
    reg.conditionLast = condition;
    await this.fire(reg, body, {});
  }

  private async fire(reg: Registration, state: HAState, extra: Record<string, unknown>): Promise<void> {
    try {
      await this.opts.workflowEngine.runWorkflow(
        reg.workflowName,
        {
          entity_id: state.entity_id,
          state: state.state,
          attributes: state.attributes ?? {},
          last_changed: state.last_changed,
          last_updated: state.last_updated,
          ...extra,
        },
        "programmatic",
      );
    } catch (err) {
      console.warn(
        `[home_assistant] failed to fire workflow "${reg.workflowName}": ${(err as Error).message}`,
      );
    }
  }
}

export function matchesCondition(
  rawState: string,
  config: Pick<HomeAssistantTriggerConfig, "stateEquals" | "numericAbove" | "numericBelow">,
): boolean {
  if (config.stateEquals !== undefined) {
    return rawState === config.stateEquals;
  }
  const numeric = parseFloat(rawState);
  if (!Number.isFinite(numeric)) return false;
  if (config.numericAbove !== undefined) return numeric > config.numericAbove;
  if (config.numericBelow !== undefined) return numeric < config.numericBelow;
  return false;
}
