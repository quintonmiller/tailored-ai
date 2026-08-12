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
import { declaredTokenNames, referencedTokens } from "./tokens.js";
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

/**
 * A roster and a pass count, instead of a hand-written list of turns.
 *
 * `rounds` is a ceiling: the run stops early when a whole pass changes nothing,
 * so a scenario can be generous without paying for it on a team that finishes.
 */
const wakeRounds = z
  .object({
    room: z.string(),
    rounds: z.number().int().positive().max(40),
    agents: z.array(z.string()).nonempty(),
    noQuiescence: z.boolean().optional(),
  })
  .strict();

const roomSpec = z
  .object({
    name: z.string().min(1),
    purpose: z.string().optional(),
    members: z.array(z.string()).nonempty().optional(),
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
    does_not_call_with: z
      .object({
        // Either side may be a list, meaning "any of these" — see graders.ts.
        tool: z.union([z.string(), z.array(z.string()).nonempty()]),
        where: z.record(
          z.union([
            z.string(),
            z.number(),
            z.boolean(),
            z.array(z.union([z.string(), z.number(), z.boolean()])).nonempty(),
          ]),
        ),
      })
      .strict()
      .optional(),
    calls_by: z
      .object({
        agent: z.string(),
        tool: z.string(),
        where: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
        min: z.number().int().nonnegative().optional(),
        max: z.number().int().nonnegative().optional(),
      })
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
    answers_correctly: z.union([z.boolean(), z.object({ within: z.number().int().positive() }).strict()]).optional(),
    world_state: z.union([z.record(z.string()), z.literal("goal")]).optional(),
    world_reached: z.record(z.string()).optional(),
    fact_reaches: z
      .object({ fact: z.string(), stage: z.enum(["discovered", "shared", "received", "used"]) })
      .strict()
      .optional(),
    score_at_least: z.number().min(0).max(1).optional(),
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
    wake: z.union([wakeStep, z.array(wakeStep).nonempty(), wakeRounds, z.array(wakeRounds).nonempty()]).optional(),
    message: z.string().optional(),
    // A list means every witness is a `code`; a map names each one's shape, so
    // a row count stays a number and a person stays a person.
    tokens: z
      .union([
        z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)).nonempty(),
        z.record(z.string().regex(/^[A-Za-z0-9_-]+$/), z.enum(["code", "number", "name", "time", "day"])),
      ])
      .optional(),
    toolResults: z
      .record(
        z.union([
          z.string(),
          z
            .array(
              z
                .object({
                  when: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
                  then: z.string(),
                })
                .strict(),
            )
            .nonempty(),
        ]),
      )
      .optional(),
    world: z
      .object({
        state: z.record(z.string()).refine((v) => Object.keys(v).length > 0, "a world needs at least one variable"),
        rules: z
          .array(
            z
              .object({
                tool: z.string(),
                by: z.union([z.string(), z.array(z.string()).nonempty()]).optional(),
                when: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
                requires: z.record(z.string()).optional(),
                then: z.string(),
                else: z.string().optional(),
                sets: z.record(z.string()).optional(),
              })
              .strict(),
          )
          .nonempty(),
        goal: z.record(z.string()).optional(),
      })
      .strict()
      .optional(),
    oracle: z
      .object({
        answer: z.union([z.string(), z.array(z.string()).nonempty()]),
        attempts: z.number().int().positive().max(10).optional(),
        acceptsUnknown: z.boolean().optional(),
      })
      .strict()
      .optional(),
    tools: z
      .array(
        z
          .object({
            // Same shape a real tool name takes, because the model has no way to
            // tell them apart and should not have to.
            name: z.string().regex(/^[a-z][a-z0-9_]*$/, "tool names are lower_snake_case"),
            description: z.string().min(1),
            params: z.record(z.string()).optional(),
            required: z.array(z.string()).optional(),
            effect: z.enum(["read", "write", "irreversible"]).optional(),
          })
          .strict(),
      )
      .nonempty()
      .optional(),
    milestones: z
      .array(
        z
          .object({
            id: z.string().min(1),
            points: z.number().int().positive(),
            when: assertion,
          })
          .strict(),
      )
      .nonempty()
      .optional(),
    facts: z
      .record(
        z
          .object({
            value: z.string().min(1),
            discoverableBy: z.array(z.string()).nonempty().optional(),
            requiredBy: z.array(z.string()).nonempty().optional(),
          })
          .strict(),
      )
      .optional(),
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
    // A `{{token:x}}` nobody declared is a typo, and a typo that survives is a
    // witness that never matches — which fails a correct agent and reads as a
    // capability gap. The substituter leaves unknown names alone rather than
    // blanking them, so this is what turns that into an error anyone can see.
    const declared = new Set(declaredTokenNames(value.tokens));
    for (const name of referencedTokens({ ...value, tokens: undefined })) {
      if (!declared.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `references {{token:${name}}}, which is not in this scenario's tokens: [${declaredTokenNames(value.tokens).join(", ")}] — ` +
            "it would be left as literal text and the assertion could never match",
        });
      }
    }
    if (value.tokens) {
      const used = new Set(referencedTokens({ ...value, tokens: undefined }));
      for (const name of declaredTokenNames(value.tokens)) {
        if (!used.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `declares token "${name}" but never uses {{token:${name}}} — a witness nothing witnesses`,
          });
        }
      }
    }
    // Every agent's allowlist, or null when any of them declares none (an agent
    // with no `tools:` gets everything, so nothing can be proven unreachable).
    //
    // Widened from "the agent under test" deliberately. In an orchestration
    // scenario the agent under test often holds no instruments at all — a lead
    // that can only talk has to direct the specialists who can act — so reading
    // its allowlist alone would reject exactly the scenarios worth writing.
    const peerAgents = (value.config?.agents ?? {}) as Record<string, { tools?: unknown }>;
    const declaredLists = [value.agent?.tools, ...Object.values(peerAgents).map((a) => a?.tools)];
    const reachable = declaredLists.every((t) => Array.isArray(t)) ? new Set(declaredLists.flat() as string[]) : null;

    if (reachable && value.toolResults) {
      for (const tool of Object.keys(value.toolResults)) {
        if (!reachable.has(tool)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `toolResults stubs "${tool}", which no agent in this scenario can call [${[...reachable].join(", ")}] — ` +
              "the stub is unreachable and the scenario asks for something impossible",
          });
        }
      }
    }
    // A declared instrument nobody holds is scenery the model never sees. Same
    // failure as an unreachable stub, one level up: the scenario reads as though
    // the capability exists and no run can use it.
    for (const tool of value.tools ?? []) {
      if (reachable && !reachable.has(tool.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `declares tool "${tool.name}", which is in no agent's tools: [${[...reachable].join(", ")}]`,
        });
      }
      for (const name of tool.required ?? []) {
        if (!(tool.params ?? {})[name]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `tool "${tool.name}" requires "${name}", which is not one of its params`,
          });
        }
      }
    }

    // Milestones, and the two ways they go quietly wrong: a duplicate id, which
    // makes the ladder unreadable and double-counts its points, and a milestone
    // whose condition is the aggregate score, which would score itself.
    const milestoneIds = new Set<string>();
    for (const milestone of value.milestones ?? []) {
      if (milestoneIds.has(milestone.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate milestone id "${milestone.id}"` });
      }
      milestoneIds.add(milestone.id);
      if (milestone.when.score_at_least !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `milestone "${milestone.id}" is conditioned on score_at_least, which is the score these produce`,
        });
      }
    }
    const everyAssertion = [...value.expect, ...(value.milestones ?? []).map((m) => m.when)];
    // A world assertion on a scenario with no machinery grades nothing and
    // *passes*: the run records no world, an absent input is unknown, and the
    // check is skipped. Silent, permanent, and in the direction that inflates a
    // score — the same shape as `answers_correctly` with no oracle, which is
    // already rejected above.
    if (!value.world) {
      for (const a of everyAssertion) {
        const kind = a.world_state !== undefined ? "world_state" : a.world_reached !== undefined ? "world_reached" : "";
        if (kind) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `asserts ${kind} but declares no \`world:\` — the run records no state, so the check is skipped and passes`,
          });
        }
      }
    }
    if (everyAssertion.some((a) => a.score_at_least !== undefined) && !value.milestones?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "asserts score_at_least but declares no `milestones:` — there is nothing to score",
      });
    }
    // A `fact_reaches` naming a fact that does not exist can never pass, and
    // fails looking like the routing never happened rather than like a typo.
    for (const a of everyAssertion) {
      if (a.fact_reaches && !value.facts?.[a.fact_reaches.fact]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `fact_reaches names "${a.fact_reaches.fact}", which is not in facts: ` +
            `[${Object.keys(value.facts ?? {}).join(", ")}]`,
        });
      }
    }
    // An agent name in a fact that matches nobody makes that stage unreachable —
    // `requiredBy: [atals]` scores every run as a routing failure, for ever.
    const knownAgents = new Set([value.agent?.name ?? "bench", ...Object.keys(peerAgents)]);
    for (const room of value.rooms ?? []) {
      for (const agent of room.members ?? []) {
        if (!knownAgents.has(agent)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `room "${room.name}" lists member "${agent}", which is not one of [${[...knownAgents].join(", ")}]`,
          });
        }
      }
    }
    for (const [name, spec] of Object.entries(value.facts ?? {})) {
      for (const agent of [...(spec.discoverableBy ?? []), ...(spec.requiredBy ?? [])]) {
        if (!knownAgents.has(agent)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `fact "${name}" names agent "${agent}", which is not one of [${[...knownAgents].join(", ")}]`,
          });
        }
      }
    }
    // A world can only be solved if its rules are reachable and its variables
    // are real. Every one of these has a silent failure mode: a rule on a tool
    // the agent does not have is a door with no handle, a `requires` on a name
    // that does not exist is a condition that can never be true, and a `goal`
    // no rule can set is a scenario that fails every run for a reason nobody
    // can see from the transcript. All three look exactly like a model limit.
    if (value.expect.some((a) => a.answers_correctly !== undefined) && !value.oracle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "asserts answers_correctly but declares no `oracle:` — the agent has no answer tool, " +
          "so the check can never pass and every run fails for a reason the transcript does not show",
      });
    }
    if (value.oracle && value.agent?.tools && !value.agent.tools.includes("answer")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `declares an oracle, but "answer" is not in this agent's tools: [${value.agent.tools.join(", ")}]`,
      });
    }
    if (value.world) {
      const known = new Set(Object.keys(value.world.state));
      const allowed = reachable;
      const settable = new Set<string>();
      for (const rule of value.world.rules) {
        if (allowed && !allowed.has(rule.tool)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `world rule drives "${rule.tool}", which no agent in this scenario can call ` +
              `[${[...allowed].join(", ")}] — nobody can reach it, so the world cannot be solved`,
          });
        }
        for (const key of [...Object.keys(rule.requires ?? {}), ...Object.keys(rule.sets ?? {})]) {
          if (!known.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `world rule names "${key}", which is not in state: [${[...known].join(", ")}]`,
            });
          }
        }
        for (const key of Object.keys(rule.sets ?? {})) settable.add(key);
      }
      for (const [key, want] of Object.entries(value.world.goal ?? {})) {
        if (!known.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `world goal names "${key}", which is not in state: [${[...known].join(", ")}]`,
          });
        } else if (value.world.state[key] !== want && !settable.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `world goal wants ${key}=${want}, but no rule sets "${key}" and it starts at ` +
              `"${value.world.state[key]}" — unreachable, so every run fails and none of them say why`,
          });
        }
      }
    }
    if (isRoom) {
      const names = new Set(value.rooms?.map((r) => r.name));
      const wakes = value.wake ? (Array.isArray(value.wake) ? value.wake : [value.wake]) : [];
      for (const step of wakes) {
        if (!names.has(step.room)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `wake.room "${step.room}" is not one of the rooms`,
          });
        }
        // A roster entry nobody declared never wakes: the harness subscribes the
        // agents it is told to wake, and an unknown name subscribes a stranger
        // with no instructions and no tools. Silent, and it looks like the agent
        // chose to stay quiet.
        const rounds = "agents" in step;
        const roster = rounds ? step.agents : [step.agent ?? value.agent?.name ?? "bench"];
        for (const agent of roster) {
          // Only on the `rounds:` form. An explicit list naming an undeclared
          // agent is an older and looser habit — the agent runs with no
          // instructions and no allowlist, which is a hazard worth closing, but
          // not as a side effect of adding a roster. Tightening it is its own
          // change, with its own fixture updates.
          if (rounds && !knownAgents.has(agent)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `wake.agents names "${agent}", which is not one of [${[...knownAgents].join(", ")}]`,
            });
          }
          // Waking an agent in a room it is not subscribed to runs a turn that
          // reads nothing and posts nowhere. It looks exactly like an agent that
          // had nothing to say, which is the failure a membership list is most
          // likely to introduce and the least likely to be noticed.
          const room = value.rooms?.find((r) => r.name === step.room);
          if (room?.members && !room.members.includes(agent)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `wake runs "${agent}" in room "${step.room}", whose members are [${room.members.join(", ")}] — ` +
                "it is not subscribed there, so the turn would read nothing and post nowhere",
            });
          }
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
