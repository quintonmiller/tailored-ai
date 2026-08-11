/**
 * Scenario loading and validation.
 *
 * Validated rather than trusted because the failure mode of a typo is silent:
 * an assertion key nobody recognises grades nothing, the scenario passes, and
 * the benchmark reports a higher score for having checked less. Every unknown
 * key is an error here, and every `expect` entry must carry exactly one
 * assertion so a failure can name itself.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { MAX_DIFFICULTY, MIN_DIFFICULTY, parseDifficultyFilter } from "./difficulty.js";
import type { Scenario } from "./types.js";

const roomLine = z
  .object({
    speaker: z.string().min(1),
    to: z.array(z.string()).optional(),
    body: z.string().min(1),
  })
  .strict();

/**
 * One turn: whose, and where. `agent` defaults to the agent under test, so a
 * single-agent scenario never names it and a multi-agent one always does.
 */
const wakeStep = z
  .object({
    room: z.string(),
    agent: z.string().optional(),
    kind: z.enum(["poll", "checkin"]).optional(),
  })
  .strict();

const roomSpec = z
  .object({
    name: z.string().min(1),
    purpose: z.string().optional(),
    deliver: z.enum(["push", "poll"]).optional(),
    wakeOn: z.enum(["named", "addressed", "all", "none"]).optional(),
    checkInMinutes: z.number().nullable().optional(),
    role: z.string().optional(),
    seen: z.array(roomLine).optional(),
    incoming: z.array(roomLine).optional(),
  })
  .strict();

const assertion = z
  .object({
    calls_tool: z.string().optional(),
    calls_tool_any: z.array(z.string()).optional(),
    does_not_call: z.array(z.string()).optional(),
    tool_args: z
      .object({ tool: z.string(), where: z.record(z.union([z.string(), z.number(), z.boolean()])) })
      .strict()
      .optional(),
    posts_in: z.string().optional(),
    does_not_post_in: z.array(z.string()).optional(),
    posts_by: z
      .object({
        agent: z.string(),
        min: z.number().int().nonnegative().optional(),
        max: z.number().int().nonnegative().optional(),
        matches: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    replies: z.boolean().optional(),
    reply_matches: z.string().optional(),
    reply_not_matches: z.string().optional(),
    reply_mentions_any: z.array(z.string()).optional(),
    reply_mentions_all: z.array(z.string()).nonempty().optional(),
    reply_mentions_none: z.array(z.string()).optional(),
    max_reply_chars: z.number().optional(),
    min_reply_chars: z.number().optional(),
    max_overlap: z
      .object({ threshold: z.number(), prior_reply: z.boolean().optional(), text: z.string().optional() })
      .strict()
      .optional(),
    prompt_contains: z.string().optional(),
    prompt_not_contains: z.string().optional(),
    prompt_occurrences: z
      .object({ text: z.string(), min: z.number().optional(), max: z.number().optional() })
      .strict()
      .optional(),
    prompt_max_tokens: z.number().optional(),
    max_rounds: z.number().optional(),
    max_tool_calls: z.number().optional(),
    judge: z.object({ rubric: z.string() }).strict().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = Object.keys(value).filter((k) => value[k as keyof typeof value] !== undefined);
    if (keys.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `each expect entry needs exactly one assertion, got ${keys.length}${keys.length ? `: ${keys.join(", ")}` : ""}`,
      });
    }
  });

const scenario = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    intent: z.string().min(1),
    difficulty: z.number().int().min(MIN_DIFFICULTY).max(MAX_DIFFICULTY),
    knownGap: z.string().min(1).optional(),
    agent: z
      .object({
        name: z.string().optional(),
        description: z.string().optional(),
        instructions: z.string().optional(),
        tools: z.array(z.string()).nonempty().optional(),
        extra: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
    config: z.record(z.unknown()).optional(),
    history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict()).optional(),
    rooms: z.array(roomSpec).optional(),
    wake: z.union([wakeStep, z.array(wakeStep).nonempty()]).optional(),
    message: z.string().optional(),
    toolResults: z.record(z.string()).optional(),
    repeats: z.number().int().positive().optional(),
    expect: z.array(assertion).nonempty(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isRoom = !!value.rooms?.length;
    if (isRoom === !!value.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a scenario is either a room scenario (`rooms:`) or a chat scenario (`message:`), not both or neither",
      });
    }
    // A canned result for a tool the agent cannot reach is a scenario that
    // asks for something impossible, and it fails looking exactly like a model
    // limitation: the agent says it has no way to check, which is true. Four
    // scenarios were written this way in one afternoon — usually by reusing an
    // `&anchor` whose `tools:` list is narrower than the new row needs — and
    // each one cost a benchmark run to diagnose. Cheap to make impossible.
    if (value.agent?.tools && value.toolResults) {
      const allowed = new Set(value.agent.tools);
      for (const tool of Object.keys(value.toolResults)) {
        if (!allowed.has(tool)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `toolResults stubs "${tool}", which is not in this agent's tools: [${value.agent.tools.join(", ")}] — ` +
              "the agent cannot call it, so the stub is unreachable and the scenario asks for something impossible",
          });
        }
      }
    }
    if (isRoom) {
      const names = new Set(value.rooms?.map((r) => r.name));
      for (const step of value.wake ? (Array.isArray(value.wake) ? value.wake : [value.wake]) : []) {
        if (!names.has(step.room)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `wake.room "${step.room}" is not one of the rooms`,
          });
        }
      }
      if (!value.wake && !value.rooms?.some((r) => r.incoming?.length)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "no `wake:` and no room has `incoming:` — nothing wakes the agent",
        });
      }
    }
  });

/**
 * Fields that say why a scenario exists without changing what it measures.
 *
 * `intent` is prose for a reader, `knownGap` marks a row as deliberately red,
 * and `difficulty` says how hard the turn is; none of the three reaches the
 * model or the graders. They are excluded from the digest so annotating a
 * scenario does not invalidate every run that came before — which is the whole
 * point of reading them from the scenario file instead of baking them into each
 * report.
 *
 * `difficulty` in particular has to be here: the scale was applied to a set
 * that already existed, and grading it is a judgement that will be revised.
 * Counting it would mean every re-grade costs a full re-baseline, and the
 * predictable result is that nobody re-grades anything.
 */
const ANNOTATION_FIELDS = new Set(["intent", "knownGap", "difficulty"]);

/** Key-sorted, so the digest tracks meaning rather than authoring order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, canonical(source[key])]),
    );
  }
  return value;
}

/**
 * What a scenario actually puts in front of the model, and what it grades.
 *
 * Digesting this rather than the file bytes means a comment, a reflow or an
 * annotation leaves the identity of the set alone, and a changed assertion
 * moves it. The bytes version got both backwards.
 */
function measuredShape(parsed: Scenario): unknown {
  return canonical(
    Object.fromEntries(
      Object.entries(parsed).filter(([key, value]) => !ANNOTATION_FIELDS.has(key) && value !== undefined),
    ),
  );
}

/**
 * A digest of one scenario's measured shape.
 *
 * The set hash answers "were these runs defined the same way" for two reports.
 * It cannot answer the question a *published* run raises: the site pairs an old
 * result with today's scenario file for the intent and annotations, so a
 * scenario that kept its id and changed its assertions renders an old number
 * under a new description, and nothing sees it. Per-scenario digests make that
 * specific rather than a moved hash nobody can act on.
 */
export function fingerprintScenario(scenario: Scenario): string {
  return createHash("sha256")
    .update(JSON.stringify(measuredShape(scenario)))
    .digest("hex")
    .slice(0, 12);
}

export function loadScenarios(
  dir: string,
  filter?: string,
  difficulty?: string,
): { scenarios: Scenario[]; hash: string; fingerprints: Record<string, string> } {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const scenarios: Scenario[] = [];
  const hash = createHash("sha256");
  const fingerprints: Record<string, string> = {};
  const seen = new Set<string>();

  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    const parsed = YAML.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${file}: expected a list of scenarios at the top level`);
    for (const entry of parsed) {
      const result = scenario.safeParse(entry);
      if (!result.success) {
        const id = typeof entry?.id === "string" ? entry.id : "(no id)";
        const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
        throw new Error(`${file} → ${id}:\n${issues}`);
      }
      if (seen.has(result.data.id)) throw new Error(`${file}: duplicate scenario id "${result.data.id}"`);
      seen.add(result.data.id);
      scenarios.push(result.data as Scenario);
      hash.update(JSON.stringify(measuredShape(result.data as Scenario)));
      fingerprints[result.data.id] = fingerprintScenario(result.data as Scenario);
    }
  }

  // Both filters narrow, and they compose: `--filter long-session --difficulty
  // 4+` is the hard half of one category. The digest and the fingerprints are
  // taken over the *whole* set above, before either applies, so a filtered run
  // still records which version of the questions it was answering.
  let selected = filter ? scenarios.filter((s) => s.id.includes(filter) || s.category === filter) : scenarios;
  if (difficulty) {
    const wanted = parseDifficultyFilter(difficulty);
    selected = selected.filter((s) => wanted(s.difficulty));
  }
  return { scenarios: selected, hash: hash.digest("hex").slice(0, 12), fingerprints };
}
