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
import { grade, type JudgeFn } from "./graders.js";
import { type HarnessOptions, runOnce } from "./harness.js";
import { writeWorkerResult } from "./protocol.js";
import { mintTokens, substituteTokens } from "./tokens.js";
import type { RunOutcome, RunResult, Scenario, ScenarioResult } from "./types.js";

interface Payload {
  scenario: Scenario;
  options: HarnessOptions;
  repeats: number;
  judge: boolean;
  /** Keep the full prompt text on every run, so the report can be fully re-graded later. */
  keepPrompts?: boolean;
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
  const judge = payload.judge ? makeJudge(payload.options) : undefined;

  const runs: RunResult[] = [];
  for (let i = 0; i < repeats; i++) {
    // A seed per repeat: reproducible across benchmark runs, varied within one.
    // Without this a repeat count of 3 is three identical samples on a server
    // that honours seeds, and measures nothing about variance.
    const options: HarnessOptions = {
      ...payload.options,
      seed: payload.options.seed === null ? null : payload.options.seed + i,
    };
    // Minted here, and used for the run *and* the grade, because a witness is
    // only a witness if the check and the thing it checks carry the same value.
    // Minting inside `runOnce` looked tidier and silently broke exactly that:
    // the agent assembled the code correctly, the stub returned the secret, and
    // the assertion was still looking for the literal `{{token:secret}}`.
    // Fresh per repeat, so a value cannot survive from one run into the next.
    const tokens = mintTokens(scenario.tokens ?? []);
    const scoped = scenario.tokens?.length ? substituteTokens(scenario, tokens) : scenario;

    const outcome = await runOnce(scoped, options);
    const checks = await grade(scoped, outcome, { judge });
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
    runs.push({ pass, checks, outcome: stored });
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
