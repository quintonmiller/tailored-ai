/**
 * What the page works with: the shared scene, plus the shapes only it has.
 *
 * The scene half lives in `src/broadcast-contract.ts` so the simulation can be
 * checked against it; everything below is the browser's own — the trace as the
 * store folds it, and the mount signature every renderer returns.
 */

export type {
  ClassId,
  DamageElement,
  Phase,
  Scene,
  SceneBeat,
  SceneEnemy,
  SceneItem,
  ScenePartyMember,
  SceneStatus,
} from "../../../src/broadcast-contract.js";

import type { Scene, ScenePartyMember, SceneEnemy } from "../../../src/broadcast-contract.js";

// ---------------------------------------------------------------------------
// The trace, as the page sees it
// ---------------------------------------------------------------------------

export interface RunEvent {
  kind: "run";
  at: number;
  scenario: string;
  intent?: string;
  model: string;
  agents: string[];
  rooms: string[];
  roomMembers?: Record<string, string[]>;
  roles?: Record<string, string>;
  rounds?: number;
  milestones?: Array<{ id: string; points: number }>;
}

export interface FeedRound {
  type: "round";
  round: number;
  text: string;
  at: number;
}
export interface FeedSay {
  type: "say";
  agent: string;
  text: string;
  at: number;
}
export interface FeedCall {
  type: "call";
  agent: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  refused: boolean;
  at: number;
}
export interface FeedEnd {
  type: "end";
  text: string;
  at: number;
}
export type FeedItem = FeedRound | FeedSay | FeedCall | FeedEnd;

export interface Said {
  agent: string;
  room: string;
  body: string;
  turn: number;
  at: number;
}

export interface Milestone {
  id: string;
  reached: boolean;
}

export interface NarrationLine {
  text: string;
  round: number;
  at: number;
}

/** One past run, as `/history` reports it. Mirrors `RunRecord` in `src/history.ts`. */
export interface RunRecord {
  file: string;
  scenario: string;
  model: string;
  startedAt: number;
  endedAt: number;
  rounds: number;
  turns: number;
  score: number | null;
  floor: number | null;
  bosses: number | null;
  survivors: number | null;
  points: number | null;
  outOf: number | null;
  endedBecause: string | null;
  finished: boolean;
}

export interface History {
  runs: RunRecord[];
  best: RunRecord | null;
  previous: RunRecord | null;
  today: { runs: number; best: number | null };
  week: { runs: number; best: number | null };
}

/** Everything the store keeps. Renderers receive this and nothing else. */
export interface BroadcastState {
  run: RunEvent | null;
  scene: Scene | null;
  previous: Scene | null;
  round: number;
  rounds: number;
  feed: FeedItem[];
  said: Said[];
  milestones: Milestone[];
  narration: NarrationLine[];
  history: History | null;
  live: boolean;
  ended: boolean;
  endedBecause: string | null;
  file: string;
  version: number;
  roundVersion: number;
}

/** What `derive()` works out once so no two panels disagree about it. */
export interface Derived {
  alive: ScenePartyMember[];
  fallen: ScenePartyMember[];
  enemies: SceneEnemy[];
  inCombat: boolean;
  health: number;
  dire: boolean;
  boss: SceneEnemy | null;
  telegraph: SceneEnemy | null;
  progress: number;
}

/** Every module mounts to a host and hands back a renderer. */
export type Renderer = (state: BroadcastState) => void;
