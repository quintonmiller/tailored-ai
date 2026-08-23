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
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AIProvider, ChatParams, ChatResponse } from "@tailored-ai/core";

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

/** Read a recording. A missing or empty file yields no fixtures. */
export function loadFixtures(path: string): Fixture[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const fixtures: Fixture[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      fixtures.push(JSON.parse(line) as Fixture);
    } catch (err) {
      // One malformed line is not a reason to discard a long recording, but it
      // is a reason to say so — a silently short fixture file reads as a
      // divergence later, at a confusing place.
      console.warn(`[replay] ${path}:${i + 1} is not valid JSON and was skipped: ${(err as Error).message}`);
    }
  }
  return fixtures;
}

/** Open a recording for append. Returns the sink `recordingProvider` wants. */
export function fixtureWriter(path: string): (fixture: Fixture) => void {
  mkdirSync(dirname(path), { recursive: true });
  // Truncate up front so a re-record replaces the previous run rather than
  // appending a second one, which would look like divergence on replay.
  writeFileSync(path, "");
  return (fixture) => appendFileSync(path, `${JSON.stringify(fixture)}\n`);
}

/** Where one scenario's recording lives inside a record/replay directory. */
export function fixturePath(dir: string, scenarioId: string): string {
  // Scenario ids reach here from files on disk and are used as a filename.
  // Anything path-shaped is flattened rather than trusted.
  return join(dir, `${scenarioId.replace(/[^\w.-]/g, "_")}.jsonl`);
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
export function replayLayer(
  provider: AIProvider,
  opts: { recordDir?: string; replayDir?: string; scenarioId: string },
): AIProvider {
  if (opts.recordDir && opts.replayDir) {
    throw new Error(
      "replay: --record and --replay are mutually exclusive — a run either produces a recording or consumes one",
    );
  }
  if (opts.replayDir) {
    const path = fixturePath(opts.replayDir, opts.scenarioId);
    const fixtures = loadFixtures(path);
    if (fixtures.length === 0) {
      // Falling back to a live call here is the whole failure this avoids: the
      // run would silently stop being deterministic and start costing money.
      throw new Error(
        `replay: no recording for scenario "${opts.scenarioId}" at ${path} — record it first with --record`,
      );
    }
    return replayProvider(fixtures);
  }
  if (opts.recordDir) {
    return recordingProvider(provider, fixtureWriter(fixturePath(opts.recordDir, opts.scenarioId)));
  }
  return provider;
}
