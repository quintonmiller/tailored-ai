/**
 * Record a benchmark's model calls once, then run it again from the recording.
 *
 * Three problems share one cause — every run needs a live model.
 *
 * 1. **A dead endpoint scores zero and looks like a regression.** A run against
 *    an unreachable backend finishes in minutes with no error; the `Recorder`
 *    already tracks `failures` for exactly this reason, after a run against a
 *    server that accepted and never replied scored 100% on prompt assertions.
 *    Under replay there is no endpoint to be down.
 * 2. **Noise swamps small deltas.** Run-to-run swing on identical code is real,
 *    so a change worth a point or two cannot be measured by re-running. Replay
 *    is deterministic: identical code produces an identical transcript, and a
 *    diff means something actually changed.
 * 3. **CI cannot run any of it.** No key, no endpoint, no run.
 *
 * The wrapper sits on the provider seam, so nothing downstream — loop, tools,
 * compaction, slots — knows it is being replayed.
 *
 * **A miss is an error, never a live call.** Falling through to the real model
 * on a missing fixture is how a "replay" run quietly costs money and stops
 * being deterministic. The miss message names what the request was so the
 * divergence is diagnosable, because a fixture miss usually means the prompt
 * changed — which is a finding, not an accident to route around.
 *
 * `chatStream` is deliberately not implemented: every caller falls back to
 * `chat()` when it is absent, and a recorded stream would only differ from a
 * recorded response in chunk boundaries nothing here asserts on.
 *
 * A recording therefore has to hold more than the calls. Scenarios mint fresh
 * unguessable witnesses every run and substitute them into the prompt, so a
 * replay that minted its own would ask a different question and miss every
 * fixture it owned — see {@link Recording}. That was not caught by any unit
 * test, because a fake upstream answers whatever it is asked; it took one live
 * run, where sixteen of the twenty scenario files declare witnesses and the
 * only scenario that used one missed on every request.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AIProvider, ChatParams, ChatResponse } from "@tailored-ai/core";

/**
 * A recording: what one run of one scenario asked, and what it was told.
 *
 * The witnesses are stored with the calls, and that is load-bearing rather than
 * housekeeping. A scenario mints fresh unguessable values on every run *on
 * purpose* — see `tokens.ts` — and substitutes them into the prompt, so a
 * replay that minted its own would send a different request and miss every
 * fixture it owned. Sixteen of the twenty scenario files declare witnesses, so
 * "replay" without this covers the minority of the benchmark that has none.
 *
 * Reusing them costs nothing that freshness was buying. A witness is fresh so
 * that a *live* model cannot satisfy a check with a value it never read. Under
 * replay there is no model: the recorded answer either carried the value or it
 * did not, and that was decided when the recording was made. Live runs are
 * untouched and still mint cryptographically.
 */
export interface Recording {
  /** The witness values the recorded run minted. Empty if it declared none. */
  tokens: Record<string, string>;
  /** Every model call the run made, in the order it made them. */
  fixtures: Fixture[];
}

/**
 * A line in a recording file.
 *
 * Tagged on both arms rather than inferred from which fields are present: an
 * untagged header would be one renamed field away from parsing as a call with
 * an undefined key, which fails much later and reads as divergence.
 */
type RecordLine = ({ kind: "tokens" } & Pick<Recording, "tokens">) | ({ kind: "call" } & Fixture);

/** One recorded call: the request it answers, and what came back. */
export interface Fixture {
  /** Stable hash of the request — see {@link requestKey}. */
  key: string;
  /** Model the request named. Carried for readability, not matching. */
  model: string;
  /**
   * First 200 characters of the last message. Not used for lookup; it is what
   * makes a miss diagnosable and a fixture file reviewable in a diff.
   */
  preview: string;
  response: ChatResponse;
}

/**
 * Everything about a request that could change the answer, in a stable order.
 *
 * Media bytes are excluded and their refs kept: the payload can be megabytes,
 * and the reference is what identifies it. `JSON.stringify` on a plain object
 * follows insertion order, so the fields are listed explicitly rather than
 * spread — a key that moved would silently invalidate every fixture.
 */
function canonical(params: ChatParams): string {
  return JSON.stringify({
    model: params.model,
    messages: params.messages,
    tools: params.tools,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    thinking: params.thinking,
    extra: params.extra,
    // A Map, so `Object.keys` would silently yield `[]` and make every request
    // with different media hash identically.
    media: params.media ? [...params.media.keys()].sort() : undefined,
  });
}

/** Stable identity for a request. Two identical requests share a key. */
export function requestKey(params: ChatParams): string {
  return createHash("sha256").update(canonical(params)).digest("hex").slice(0, 16);
}

function previewOf(params: ChatParams): string {
  const last = params.messages[params.messages.length - 1];
  const body = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  return body.length <= 200 ? body : `${body.slice(0, 200)}…`;
}

/** Thrown when replay is asked for a request it has no answer to. */
export class ReplayMiss extends Error {
  constructor(
    readonly key: string,
    readonly preview: string,
    readonly reason: "unknown" | "exhausted",
  ) {
    super(
      reason === "exhausted"
        ? `replay: ran out of recorded responses for request ${key} — the run made more calls than the recording did, so it has diverged. Last message: ${preview}`
        : `replay: no recorded response for request ${key} — the request differs from every one recorded, so the prompt has changed. Last message: ${preview}`,
    );
    this.name = "ReplayMiss";
  }
}

/**
 * Wrap a live provider so every call is written to `sink` as it happens.
 *
 * Written per call rather than collected and flushed at the end, so a run that
 * crashes halfway still leaves a usable partial recording. That matters: the
 * runs worth recording are the long ones.
 */
export function recordingProvider(upstream: AIProvider, sink: (fixture: Fixture) => void): AIProvider {
  return {
    id: upstream.id,
    name: `${upstream.name} (recording)`,
    supportsTools: upstream.supportsTools,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const response = await upstream.chat(params);
      sink({ key: requestKey(params), model: params.model, preview: previewOf(params), response });
      return response;
    },
    listModels: upstream.listModels?.bind(upstream),
  };
}

/**
 * A provider that answers from a recording and never reaches the network.
 *
 * Identical requests are served in the order they were recorded, because the
 * same request legitimately produces different answers at a non-zero
 * temperature and a run that asks twice should get both.
 */
export function replayProvider(fixtures: readonly Fixture[], id = "replay"): AIProvider {
  const byKey = new Map<string, ChatResponse[]>();
  for (const fixture of fixtures) {
    const list = byKey.get(fixture.key);
    if (list) list.push(fixture.response);
    else byKey.set(fixture.key, [fixture.response]);
  }
  const consumed = new Map<string, number>();

  return {
    id,
    name: `Replay (${fixtures.length} recorded calls)`,
    supportsTools: true,
    async chat(params: ChatParams): Promise<ChatResponse> {
      const key = requestKey(params);
      const list = byKey.get(key);
      if (!list) throw new ReplayMiss(key, previewOf(params), "unknown");
      const index = consumed.get(key) ?? 0;
      if (index >= list.length) throw new ReplayMiss(key, previewOf(params), "exhausted");
      consumed.set(key, index + 1);
      return list[index];
    },
  };
}

/** Read a recording. A missing or empty file yields nothing. */
export function loadRecording(path: string): Recording {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { tokens: {}, fixtures: [] };
  }
  const recording: Recording = { tokens: {}, fixtures: [] };
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RecordLine;
      if (parsed.kind === "tokens") recording.tokens = parsed.tokens;
      else if (parsed.kind === "call") {
        const { kind: _kind, ...fixture } = parsed;
        recording.fixtures.push(fixture);
      } else {
        console.warn(`[replay] ${path}:${i + 1} has an unknown kind and was skipped`);
      }
    } catch (err) {
      // One malformed line is not a reason to discard a long recording, but it
      // is a reason to say so — a silently short fixture file reads as a
      // divergence later, at a confusing place.
      console.warn(`[replay] ${path}:${i + 1} is not valid JSON and was skipped: ${(err as Error).message}`);
    }
  }
  return recording;
}

/**
 * Start a recording: truncate the file and write the witness header.
 *
 * Called **once per run**, by the run itself, and deliberately not by the
 * writer. A provider is not built once per run — the runtime rebuilds it on
 * `reload()`, which the `admin` tool triggers mid-turn — and a writer that
 * truncated whenever it was constructed threw away every call recorded before
 * the rebuild. The lost call was the one whose response *caused* the reload, so
 * on replay the run's very first request was the one request missing from its
 * own recording.
 *
 * Truncating here keeps what that was for: a re-record replaces the previous
 * run rather than appending a second one, which would read as divergence.
 *
 * The witnesses go first, before any call can, because the run that is about to
 * be recorded has already substituted them into its prompts — and a replay
 * needs them *before* it starts, to substitute the same ones.
 */
export function beginRecording(dir: string, id: string, tokens: Record<string, string>): string {
  const path = fixturePath(dir, id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ kind: "tokens", tokens } satisfies RecordLine)}\n`);
  return path;
}

/**
 * A sink that appends calls to an already-started recording.
 *
 * Append-only, and never truncating: see {@link beginRecording}. Written per
 * call rather than flushed at the end so a run that crashes halfway still
 * leaves a usable partial recording — the runs worth recording are the long
 * ones.
 */
export function recordingWriter(path: string): (fixture: Fixture) => void {
  mkdirSync(dirname(path), { recursive: true });
  return (fixture) => appendFileSync(path, `${JSON.stringify({ kind: "call", ...fixture } satisfies RecordLine)}\n`);
}

/** Where one run's recording lives inside a record/replay directory. */
export function fixturePath(dir: string, runId: string): string {
  // Run ids carry a scenario id, which reaches here from a file on disk and is
  // used as a filename. Anything path-shaped is flattened rather than trusted.
  return join(dir, `${runId.replace(/[^\w.-]/g, "_")}.jsonl`);
}

/**
 * The identity of one run: a scenario, at a seed.
 *
 * Shared by the worker (which needs the witnesses before the run) and the
 * harness (which needs the file during it) so the two cannot drift. They
 * computed the same string independently once; a change to one of them would
 * have produced a run that recorded to one file and replayed from another,
 * reported as a missing recording.
 */
export function runId(scenarioId: string, seed: number | null | undefined): string {
  // `--repeats 3` runs one scenario three times at seeds n, n+1, n+2. Without
  // the seed in the name each repeat would truncate the last.
  return seed === null || seed === undefined ? scenarioId : `${scenarioId}-seed${seed}`;
}

/**
 * The witnesses a recorded run minted, for a replay about to repeat it.
 *
 * Separate from `replayLayer` because of *when* it is needed: the scenario is
 * substituted before the run starts, and the provider is not built until the
 * first model call. A missing recording is reported here rather than at that
 * first call, where the message would blame the prompt for a file that was
 * never made.
 */
export function recordedTokens(replayDir: string, id: string): Record<string, string> {
  const path = fixturePath(replayDir, id);
  const recording = loadRecording(path);
  if (recording.fixtures.length === 0) {
    throw new Error(`replay: no recording for run "${id}" at ${path} — record it first with --record`);
  }
  return recording.tokens;
}

/**
 * Put the recording layer around a scenario's provider, if either mode is on.
 *
 * Split out from the harness so the decision is testable without a live model:
 * `runOnce` cannot be exercised in a unit test, and a wiring bug here would be
 * invisible until a real run — which is precisely the class of failure this
 * whole file exists to remove.
 *
 * One directory per run, one file per scenario. Scenarios execute in separate
 * workers, so a single shared file would interleave two runs' calls and read
 * back as divergence.
 */
export interface RunRecording {
  /** Serves the recording. Built once per run, and shared by every provider it makes. */
  replaying?: AIProvider;
  /** File that calls are appended to. Already truncated and headed. */
  recordPath?: string;
}

/**
 * Prepare one run's record/replay state, before the run starts.
 *
 * Everything here is deliberately *per run* rather than per provider, because a
 * run does not build one provider. The runtime rebuilds it on `reload()`, which
 * the `admin` tool triggers mid-turn, and both halves of this were wrong when
 * that state lived on the provider:
 *
 * - Recording truncated the file on every rebuild, discarding every call so far
 *   — including the one whose response *caused* the reload.
 * - Replay built a fresh {@link replayProvider}, whose "which duplicate have I
 *   served" counter restarted at zero. A request the run makes twice would be
 *   answered with the first recorded response both times: not an error, just a
 *   quietly wrong replay, which is the exact failure this file exists to remove.
 */
export function openRun(opts: {
  recordDir?: string;
  replayDir?: string;
  id: string;
  tokens?: Record<string, string>;
}): RunRecording {
  if (opts.recordDir && opts.replayDir) {
    throw new Error(
      "replay: --record and --replay are mutually exclusive — a run either produces a recording or consumes one",
    );
  }
  if (opts.replayDir) {
    const path = fixturePath(opts.replayDir, opts.id);
    const recording = loadRecording(path);
    if (recording.fixtures.length === 0) {
      // Falling back to a live call here is the whole failure this avoids: the
      // run would silently stop being deterministic and start costing money.
      throw new Error(`replay: no recording for run "${opts.id}" at ${path} — record it first with --record`);
    }
    return { replaying: replayProvider(recording.fixtures) };
  }
  if (opts.recordDir) {
    return { recordPath: beginRecording(opts.recordDir, opts.id, opts.tokens ?? {}) };
  }
  return {};
}

/**
 * Put the run's record/replay layer around a provider, if either mode is on.
 *
 * Called once per provider the runtime builds — which is more than once per run.
 * All the state it needs was decided by {@link openRun}; this only wraps.
 */
export function replayLayer(provider: AIProvider, run: RunRecording): AIProvider {
  if (run.replaying) return run.replaying;
  if (run.recordPath) return recordingProvider(provider, recordingWriter(run.recordPath));
  return provider;
}
