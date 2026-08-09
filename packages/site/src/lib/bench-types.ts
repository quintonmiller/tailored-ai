/**
 * The shape of a benchmark report, as the site reads it.
 *
 * A deliberate structural copy of `packages/evals/src/types.ts` rather than an
 * import. The site is a static export; `@tailored-ai/evals` pulls in core and
 * `better-sqlite3`, and a native module has no business in a Next build that
 * only ever reads JSON off disk.
 *
 * The copy is safe in the direction it is used: every field here is read, none
 * is written, and a report that grows a field the site does not know about
 * still renders. A report that *loses* one is caught by `readReport`, which
 * validates the handful of fields the pages cannot do without.
 */

export interface CheckResult {
  kind: string;
  pass: boolean;
  detail?: string;
  skipped?: boolean;
}

export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
}

export interface RecordedRequest {
  system: string;
  messages: Array<{ role: string; content: string }>;
  toolNames: string[];
  estimatedTokens: number;
}

export interface RunOutcome {
  reply: string;
  providerErrors?: string[];
  retries?: number;
  calls: RecordedCall[];
  posts: Array<{ room: string; body: string }>;
  requests: RecordedRequest[];
  latencyMs: number;
  usage: { input: number; output: number };
  error?: string;
}

export interface RunResult {
  pass: boolean;
  checks: CheckResult[];
  outcome: RunOutcome;
}

export interface ScenarioResult {
  id: string;
  category: string;
  intent: string;
  knownGap?: string;
  runs: RunResult[];
  passRate: number;
  error?: string;
}

export interface ReportMeta {
  startedAt: string;
  finishedAt: string;
  gitSha: string;
  gitDirty: boolean;
  model: string;
  baseUrl: string;
  /** Absent on reports written before the provider seam landed. */
  provider?: string;
  plugins?: string[];
  repeats: number;
  seed: number | null;
  judge: boolean;
  scenarioSetHash: string;
  durationSeconds: number;
}

export interface BenchmarkReport {
  meta: ReportMeta;
  score: {
    overall: number;
    passed: number;
    total: number;
    byCategory: Record<string, { passed: number; total: number; rate: number }>;
  };
  scenarios: ScenarioResult[];
}

/** A report plus where it came from and how to link to it. */
export interface PublishedRun {
  /** URL segment, from the filename: `baseline-work-luna.json` → `baseline-work-luna`. */
  slug: string;
  /** Human label, from the filename with the `baseline-` prefix dropped. */
  label: string;
  report: BenchmarkReport;
}

/** Index entry: everything the listing and the matrix need, and nothing else. */
export interface RunSummary {
  slug: string;
  label: string;
  meta: ReportMeta;
  score: BenchmarkReport["score"];
  /** Per-scenario pass rates, for the cross-model matrix. */
  rates: Array<{ id: string; category: string; passRate: number; runs: number; passed: number }>;
}
