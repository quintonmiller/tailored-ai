import type { WorkflowEngine } from "../workflows/engine.js";

/**
 * Polls a free CSV stock quote endpoint and fires a workflow when the
 * symbol's last trade crosses a threshold in the configured direction.
 * Default provider is stooq (no API key, CSV format).
 *
 * Rising-edge dedup: the workflow runs once when the price first crosses
 * the threshold and stays quiet while the condition holds. The next fire
 * requires the price to leave the condition and re-enter it.
 */

export interface FinanceTriggerConfig {
  /**
   * Ticker symbol. Format depends on provider; for the default stooq endpoint
   * append ".us" for US equities ("aapl.us", "tsla.us"). Forex pairs use the
   * pair code without suffix (e.g. "eurusd").
   */
  symbol: string;
  /** Direction of cross to fire on. */
  cross: "above" | "below";
  /** Threshold price. */
  threshold: number;
  /** Poll interval seconds. Default 900 (15 min). Min 300. */
  intervalSeconds?: number;
  /** Override the API base URL. Defaults to https://stooq.com/q/l/ */
  apiBaseUrl?: string;
}

export interface FinancePollerOptions {
  workflowEngine: WorkflowEngine;
  fetchImpl?: typeof fetch;
}

interface Registration {
  workflowName: string;
  config: FinanceTriggerConfig;
  intervalSeconds: number;
  conditionLast: boolean | null;
  timer: ReturnType<typeof setInterval>;
}

const MIN_INTERVAL_SECONDS = 300;
const DEFAULT_INTERVAL_SECONDS = 900;
const DEFAULT_API_BASE = "https://stooq.com/q/l/";

export class FinancePoller {
  private opts: FinancePollerOptions;
  private regs: Registration[] = [];
  private fetchImpl: typeof fetch;

  constructor(opts: FinancePollerOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  register(workflowName: string, config: FinanceTriggerConfig): void {
    if (!config.symbol) throw new Error("finance trigger requires symbol");
    if (typeof config.threshold !== "number") throw new Error("finance trigger requires numeric threshold");
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
    let quote: StooqQuote;
    try {
      const base = reg.config.apiBaseUrl ?? DEFAULT_API_BASE;
      const url = `${base}?s=${encodeURIComponent(reg.config.symbol)}&f=sd2t2ohlcv&h&e=csv`;
      const res = await this.fetchImpl(url, { headers: { Accept: "text/csv" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const csv = await res.text();
      const parsed = parseStooqCsv(csv);
      if (!parsed) throw new Error(`unable to parse quote from ${url}`);
      quote = parsed;
    } catch (err) {
      console.warn(`[finance] poll failed for "${reg.workflowName}": ${(err as Error).message}`);
      return;
    }

    if (!Number.isFinite(quote.close)) {
      // Off-hours: stooq returns "N/D". Skip without changing state.
      return;
    }

    const condition =
      reg.config.cross === "above"
        ? quote.close > reg.config.threshold
        : quote.close < reg.config.threshold;

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
          symbol: reg.config.symbol,
          cross: reg.config.cross,
          threshold: reg.config.threshold,
          price: quote.close,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          volume: quote.volume,
          observed_at: `${quote.date} ${quote.time}`,
        },
        "programmatic",
      );
    } catch (err) {
      console.warn(
        `[finance] failed to fire workflow "${reg.workflowName}": ${(err as Error).message}`,
      );
    }
  }
}

interface StooqQuote {
  symbol: string;
  date: string;
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Parse a stooq CSV response. Shape:
 *
 *   Symbol,Date,Time,Open,High,Low,Close,Volume
 *   AAPL.US,2026-05-09,22:00:01,182.50,184.10,181.90,183.75,12345678
 *
 * Returns undefined on malformed input. Exported for unit tests.
 */
export function parseStooqCsv(csv: string): StooqQuote | undefined {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return undefined;
  const cols = lines[1].split(",");
  if (cols.length < 8) return undefined;
  const num = (s: string) => {
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  };
  return {
    symbol: cols[0],
    date: cols[1],
    time: cols[2],
    open: num(cols[3]),
    high: num(cols[4]),
    low: num(cols[5]),
    close: num(cols[6]),
    volume: num(cols[7]),
  };
}
