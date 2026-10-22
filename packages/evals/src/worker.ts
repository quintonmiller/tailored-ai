/**
 * One scenario, one process.
 *
 * Isolation is not tidiness here, it is correctness. The room-backend registry
 * is a module singleton keyed by backend id, so two runtimes in one process
 * both register `local` and the second one silently repoints the first at a
 * different database. Rather than serialise every room scenario, each gets its
 * own process — which also means a scenario that hangs or segfaults costs one
 * result instead of the run.
 *
 * Communication is deliberately crude: a payload file in, a result file out.
 * Tools and the runtime log freely to stdout, so the result never travels that
 * way — there is no separating it from the noise, and a big one does not
 * survive the trip (see `protocol.ts`).
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { grade, type JudgeFn, scoreMilestones } from "./graders.js";
import { type HarnessOptions, runOnce } from "./harness.js";
import { writeWorkerResult } from "./protocol.js";
import { traceFacts } from "./routing.js";
import { mintTokens, substituteTokens } from "./tokens.js";
import { fileSink, type TraceEvent, type TraceSink } from "./trace.js";
import type { RunOutcome, RunResult, Scenario, ScenarioResult } from "./types.js";

interface Payload {
  scenario: Scenario;
  options: HarnessOptions;
  repeats: number;
  judge: boolean;
  /** Keep the full prompt text on every run, so the report can be fully re-graded later. */
  keepPrompts?: boolean;
  /**
   * The file the scenario was loaded from, imported here for its side effects.
   *
   * A YAML scenario has none and this is inert. A TypeScript one may register a
   * simulation, and nothing else in this process would have done it — the
   * scenario arrives as JSON, and JSON does not carry a module's imports.
   */
  source?: string;
  /** NDJSON trace path, when somebody is watching. See `trace.ts`. */
  tracePath?: string;
}

/**
 * A sink that scores the ladder as the run happens.
 *
 * Wraps the file sink and, at each round boundary, rebuilds enough of a
 * `RunOutcome` from the events so far to hand to the *real* milestone grader.
 * Reusing the grader rather than reimplementing it in the viewer is the whole
 * point: a live ladder that disagreed with the report would be worse than no
 * live ladder, because you would believe it.
 *
 * It lives in the worker because `graders.ts` imports `harness.ts`, so the
 * harness cannot import the graders back. The worker already owns grading.
 */
function progressSink(scenario: Scenario, write: TraceSink): TraceSink {
  const seen: TraceEvent[] = [];
  let scoring = false;
  return (event) => {
    seen.push(event);
    write(event);
    // Scored at each round boundary, and once more when the run ends — without
    // the last one a run that solves the puzzle on its final turn shows a
    // ladder that stops one rung short of what the report will say, which is
    // the one moment a reader is most likely to trust the screen.
    if ((event.kind !== "round" && event.kind !== "end") || !scenario.milestones?.length || scoring) return;

    // Rebuilt from the trace rather than from the harness's own recorder, which
    // is out of reach from here. Every field a milestone can read is present;
    // anything a milestone asks for that a partial run cannot answer simply
    // reads as not-yet-reached, which is what it is.
    const partial = {
      reply: seen
        .filter((e): e is Extract<TraceEvent, { kind: "post" }> => e.kind === "post")
        .map((e) => e.body)
        .join("\n"),
      posts: seen
        .filter((e): e is Extract<TraceEvent, { kind: "post" }> => e.kind === "post")
        .map((e) => ({ room: e.room, body: e.body, agent: e.agent, turn: e.turn })),
      // Populated, not empty: `calls_tool_any` reads `calls` while `calls_by`
      // reads `executions`, so leaving this blank made half the call-shaped
      // milestones unreachable live while the other half worked — which reads
      // as a team that never used a tool it had in fact used two dozen times.
      calls: seen
        .filter((e): e is Extract<TraceEvent, { kind: "call" }> => e.kind === "call")
        .map((e) => ({ name: e.tool, args: e.args })),
      executions: seen
        .filter((e): e is Extract<TraceEvent, { kind: "call" }> => e.kind === "call")
        .map((e) => ({ name: e.tool, args: e.args, agent: e.agent, turn: e.turn, result: e.result })),
      requests: [],
      turns: seen
        .filter((e): e is Extract<TraceEvent, { kind: "turn" }> => e.kind === "turn")
        .map((e) => ({ agent: e.agent, room: e.room })),
      usage: { input: 0, output: 0 },
      latencyMs: 0,
      ...(scenario.simulation
        ? {
            simulation: {
              name: scenario.simulation.name,
              seed: scenario.simulation.seed ?? 0,
              days: event.kind === "round" ? (event.day ?? 0) : 0,
              daysManaged: event.kind === "round" ? (event.day ?? 0) : 0,
              daysPerRound: scenario.simulation.daysPerRound ?? 1,
              // `snapshot()` is metric-shaped by convention in every simulation
              // here, which is what lets a partial run report a live ladder.
              metrics:
                (seen.filter((e) => e.kind === "state").at(-1) as Extract<TraceEvent, { kind: "state" }> | undefined)
                  ?.snapshot ?? {},
              objective: 0,
              events: [],
              dayOfTurn: [],
              roles: scenario.simulation.roles,
              responses: {},
            },
          }
        : {}),
    } as unknown as RunOutcome;

    scoring = true;
    void scoreMilestones(scenario, partial)
      .then((scored) => {
        write({
          kind: "progress",
          at: Date.now(),
          round: event.kind === "round" ? event.round : -1,
          milestones: scored.map((m) => ({ id: m.id, reached: m.reached })),
        });
      })
      .catch(() => {
        // A live ladder is a convenience. It must never be able to fail a run.
      })
      .finally(() => {
        scoring = false;
      });
  };
}

/**
 * The judge, when a scenario asks for one.
 *
 * A plain HTTP call rather than a second runtime: the judge is not the thing
 * under test, and giving it the benchmark's own prompt assembly would make a
 * change to that assembly move the grader and the graded together.
 */
function makeJudge(options: HarnessOptions): JudgeFn {
  return async (rubric, reply) => {
    const body = {
      model: options.model,
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content:
            "You grade one reply against one rule. Answer with PASS or FAIL on the first line, " +
            "then one short sentence of reason. Judge only the rule you are given.",
        },
        { role: "user", content: `Rule: ${rubric}\n\nReply to judge:\n"""\n${reply}\n"""` },
      ],
    };
    const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) return { pass: false, reason: `judge call failed: HTTP ${response.status}` };
    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const verdict = json.choices?.[0]?.message?.content ?? "";
    return { pass: /^\s*pass\b/i.test(verdict), reason: verdict.replace(/\s+/g, " ").trim().slice(0, 200) };
  };
}

/**
 * A passing run's requests are dead weight; a failing one's are the whole
 * diagnosis. Forty scenarios of full transcripts would put megabytes of prompt
 * into every report file for no reason, so the request bodies are kept only
 * where somebody will read them, and truncated even there.
 */
const KEEP_CHARS = 4000;

function withoutRequests(outcome: RunOutcome): RunOutcome {
  return { ...outcome, requests: outcome.requests.map((r) => ({ ...r, system: "", messages: [] })) };
}

function trimRequests(outcome: RunOutcome): RunOutcome {
  const cut = (text: string) => (text.length <= KEEP_CHARS ? text : `${text.slice(0, KEEP_CHARS)}… [truncated]`);
  return {
    ...outcome,
    requests: outcome.requests.map((r) => ({
      ...r,
      system: cut(r.system),
      messages: r.messages.map((m) => ({ ...m, content: cut(m.content) })),
    })),
  };
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error("worker needs a payload file path");
  const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as Payload;
  const { scenario, repeats } = payload;
  if (payload.source && /\.(ts|mts|js|mjs)$/.test(payload.source)) {
    await import(pathToFileURL(payload.source).href);
  }
  const judge = payload.judge ? makeJudge(payload.options) : undefined;

  const runs: RunResult[] = [];
  for (let i = 0; i < repeats; i++) {
    // A seed per repeat: reproducible across benchmark runs, varied within one.
    // Without this a repeat count of 3 is three identical samples on a server
    // that honours seeds, and measures nothing about variance.
    // Minted here, and used for the run *and* the grade, because a witness is
    // only a witness if the check and the thing it checks carry the same value.
    // Minting inside `runOnce` looked tidier and silently broke exactly that:
    // the agent assembled the code correctly, the stub returned the secret, and
    // the assertion was still looking for the literal `{{token:secret}}`.
    // Fresh per repeat, so a value cannot survive from one run into the next.
    const tokens = mintTokens(scenario.tokens ?? []);
    const scoped = Object.keys(tokens).length ? substituteTokens(scenario, tokens) : scenario;

    // After `scoped`, because the live ladder grades the same substituted
    // scenario the run and the final grade use — a live view scoring against
    // unsubstituted tokens would disagree with the report, which is worse than
    // having no live view at all.
    const options: HarnessOptions = {
      ...payload.options,
      // Opened per repeat rather than per worker so a three-repeat run is three
      // readable traces in one file rather than three interleaved ones.
      ...(payload.tracePath ? { trace: progressSink(scoped, fileSink(payload.tracePath)) } : {}),
      seed: payload.options.seed === null ? null : payload.options.seed + i,
    };

    const outcome = await runOnce(scoped, options);
    const checks = await grade(scoped, outcome, { judge });
    // Graded whether or not anything asserts on them: a milestone ladder and a
    // fact trace are diagnosis, and the run you most want them for is the one
    // whose author had not yet worked out what to assert.
    const milestones = scoped.milestones?.length ? await scoreMilestones(scoped, outcome, { judge }) : undefined;
    const facts = scoped.facts ? traceFacts(scoped.facts, outcome) : undefined;
    const pass = checks.every((c) => c.pass);
    // Prompt text is the bulk of a report, so a passing run normally keeps only
    // the shape of its requests. `--keep-prompts` trades size for a report that
    // `regrade` can score completely — worth it on a run you intend to iterate
    // assertions against.
    const stored = payload.keepPrompts
      ? trimRequests(outcome)
      : pass
        ? withoutRequests(outcome)
        : trimRequests(outcome);
    runs.push({
      pass,
      checks,
      outcome: stored,
      ...(milestones ? { milestones } : {}),
      ...(facts ? { facts } : {}),
      ...(Object.keys(tokens).length ? { tokens } : {}),
    });
  }

  const result: ScenarioResult = {
    id: scenario.id,
    category: scenario.category,
    intent: scenario.intent,
    difficulty: scenario.difficulty,
    runs,
    passRate: runs.length ? runs.filter((r) => r.pass).length / runs.length : 0,
  };
  writeWorkerResult(payloadPath, result);
  // A timed-out model call is abandoned, not cancelled, so its socket is still
  // pending and would hold this process open long past the result being written.
  process.exit(0);
}

main().catch((err) => {
  // The payload path is re-read here rather than closed over: if it was missing
  // there is nowhere to put the result and the exit code is all the parent gets.
  const payloadPath = process.argv[2];
  if (payloadPath) writeWorkerResult(payloadPath, { error: (err as Error).message });
  process.exitCode = 1;
});
