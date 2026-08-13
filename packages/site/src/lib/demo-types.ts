/**
 * The shape of a demonstration dataset.
 *
 * Written by `pnpm run eval -- demo <report.json> --scenario <id> --out …` and
 * committed under `src/data/`. It is a real run cut down to what a page can
 * render, not a hand-written illustration — which is the whole point: the
 * figures on the demonstration pages are checkable against a report, and
 * regenerating the file is how they stay true.
 *
 * Mirrored here rather than imported from the evals package, following
 * `bench-types.ts`: the site reads that package's *output*, never its code.
 */

export interface DemoCall {
  turn: number;
  agent?: string;
  tool: string;
  args: Record<string, unknown>;
  result?: string;
  /** Set where the call changed the world or the economy rather than reporting on it. */
  acted?: boolean;
}

export interface DemoPost {
  turn?: number;
  agent?: string;
  room: string;
  body: string;
  truncated?: boolean;
}

export interface DemoWorldEvent {
  agent?: string;
  turn?: number;
  tool: string;
  call: string;
  effect: string;
  sets?: Record<string, string>;
  /** False where the machinery refused — which is how the team learns the order. */
  applied: boolean;
}

export interface DemoMilestone {
  id: string;
  points: number;
  reached: boolean;
  detail?: string;
}

export type FactStage = "discovered" | "shared" | "received" | "used";

export interface DemoFact {
  name: string;
  value: string;
  discovered?: { agent: string; turn: number };
  shared?: { agent: string; turn: number; room: string };
  received?: { agent: string; turn: number };
  used?: { agent: string; turn: number; tool: string };
  latency: number | null;
}

export interface DemoSimEvent {
  day: number;
  kind: string;
  message: string;
  visibleTo?: string[];
}

export interface DemoSimulation {
  name: string;
  seed: number;
  days: number;
  daysManaged: number;
  daysPerRound: number;
  endedBecause?: string;
  metrics: Record<string, number>;
  events: DemoSimEvent[];
  dayOfTurn: number[];
  roles: Record<string, string>;
  responses: Record<string, string[]>;
  baselines: Array<{ policy: string; enterpriseValue: number; serviceLevel: number; bankrupt: number }>;
  openingValue: number;
}

export interface Demo {
  scenario: string;
  category: string;
  intent: string;
  difficulty?: number;
  model: string;
  gitSha: string;
  startedAt: string;
  passRate: number;
  passed: boolean;
  checks: Array<{ kind: string; pass: boolean; detail?: string }>;
  agents: string[];
  turns: Array<{ agent: string; room: string }>;
  rooms: string[];
  calls: DemoCall[];
  posts: DemoPost[];
  world?: Record<string, string>;
  worldLog?: DemoWorldEvent[];
  milestones?: DemoMilestone[];
  facts?: DemoFact[];
  simulation?: DemoSimulation;
  usage: { input: number; output: number };
  latencyMs: number;
  rounds: number;
}
