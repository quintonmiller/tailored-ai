/**
 * Config that parses, reads correctly to a human, and does nothing.
 *
 * Both cases below are transcribed from one deployment. `enabled: "false"` on
 * a cron job kept it running for six hours after an agent was asked to disable
 * it and reported "Done" — `job.enabled !== false` is true for the string. The
 * `allowedCommands: [true, false]` one meant the shell builtins, became YAML
 * booleans, and matched nothing; harmless, because it fails closed, and just
 * as invisible.
 */
import { describe, expect, it } from "vitest";
import { type AgentConfig, findInertConfig, normalizeRawConfig, validateConfig } from "../config.js";
import { AGENT_DEFINITION_KEYS, findShapeIssues } from "../config-schema.js";

/** A config built the way the loader builds one: defaults merged under the file. */
function config(raw: Record<string, unknown>): AgentConfig {
  return normalizeRawConfig(raw);
}

describe("findShapeIssues — the quoted flag", () => {
  it("catches a cron job disabled with a string and says which way it currently reads", () => {
    const issues = findShapeIssues(
      config({
        cron: { enabled: true, jobs: [{ name: "sweep", schedule: "0 * * * *", prompt: "go", enabled: "false" }] },
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Cron job "sweep"');
    expect(issues[0]).toContain("must be a boolean");
    // The consequence is inverted and counter-intuitive; saying so is the point.
    expect(issues[0]).toContain("reads as `true`");
    expect(issues[0]).toContain("Write `false` without them");
  });

  it("says nothing about a job whose flag is a real boolean", () => {
    const issues = findShapeIssues(
      config({
        cron: { enabled: true, jobs: [{ name: "sweep", schedule: "0 * * * *", prompt: "go", enabled: false }] },
      }),
    );
    expect(issues).toEqual([]);
  });

  it("falls back to the job's position when its name is the broken field", () => {
    const issues = findShapeIssues(
      config({ cron: { enabled: true, jobs: [{ schedule: "0 * * * *", prompt: "go" }] } }),
    );
    expect(issues.some((i) => i.includes("Cron job #1") && i.includes("`name`"))).toBe(true);
  });

  it("catches the same mistake in an open bag, where only `enabled` is core's to judge", () => {
    const issues = findShapeIssues(config({ tools: { gmail: { enabled: "false", scopes: ["readonly"] } } }));

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("tools.gmail");
    // A plugin's own keys are the plugin's business and must not be touched.
    expect(issues[0]).not.toContain("scopes");
  });
});

describe("findShapeIssues — time provider", () => {
  it("catches a non-string timezone before runtime resolution", () => {
    const issues = findShapeIssues(config({ time: { provider: "system", timezone: 123 } }));
    expect(
      issues.some((issue) => issue.includes("time") && issue.includes("`timezone`") && issue.includes("string")),
    ).toBe(true);
  });
});

describe("findShapeIssues — the exec allowlist", () => {
  it("catches list entries that YAML turned into booleans", () => {
    const issues = findShapeIssues(config({ tools: { exec: { enabled: true, allowedCommands: [true, false] } } }));

    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain("tools.exec");
    expect(issues[0]).toContain("`allowedCommands.0`");
    expect(issues[0]).toContain("must be a string");
  });

  it("leaves a correct exec block alone, including keys core does not own", () => {
    const issues = findShapeIssues(
      config({
        tools: { exec: { enabled: true, allow: ["ntn", "jq"], deny: ["rm"], mode: "intersect", timeoutMs: 30000 } },
      }),
    );
    expect(issues).toEqual([]);
  });

  it("names the accepted values for a bad mode", () => {
    const issues = findShapeIssues(config({ tools: { exec: { enabled: true, mode: "union" } } }));
    expect(issues[0]).toContain("`intersect`");
    expect(issues[0]).toContain("`override`");
  });
});

describe("findShapeIssues — agent blocks", () => {
  it("catches a quoted number", () => {
    const issues = findShapeIssues(config({ agents: { writer: { temperature: "0.3" } } }));

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Agent "writer"');
    expect(issues[0]).toContain("must be a number");
    expect(issues[0]).toContain("Write `0.3` without them");
  });

  it("catches a field the old hand-written checks never covered", () => {
    // `fileBoundary` is a security boundary. Nothing type-checked it before.
    const issues = findShapeIssues(config({ agents: { coder: { fileBoundary: ["~/repos"] } } }));
    expect(issues[0]).toContain("`fileBoundary`");
    expect(issues[0]).toContain("got a list");
  });

  it("reports a key written with no value, which is a key nothing will read", () => {
    const issues = findShapeIssues(config({ agents: { writer: { instructions: null } } }));
    expect(issues[0]).toContain("null (an empty key)");
  });

  it("accepts a sandbox kind core has never heard of, because plugins register them", () => {
    expect(findShapeIssues(config({ agents: { coder: { sandbox: "firecracker" } } }))).toEqual([]);
  });

  it("reports what is actually wrong inside a one-or-many field", () => {
    // `hooks.beforeRun` takes a hook or a list of them. "Matches no accepted
    // shape" would bury the only fact worth having.
    const issues = findShapeIssues(config({ agents: { w: { hooks: { beforeRun: { tool: 5 } } } } }));
    expect(issues[0]).toContain("`hooks.beforeRun.tool` must be a string");
  });

  it("accepts a fully populated agent", () => {
    const issues = findShapeIssues(
      config({
        agents: {
          full: {
            description: "d",
            model: "m",
            provider: "p",
            models: [{ provider: "p", model: "m", maxContextTokens: 8000 }],
            instructions: "i",
            tools: ["exec"],
            temperature: 0.3,
            thinking: "off",
            maxTokens: 2048,
            maxToolRounds: 10,
            fileBoundary: "~/repos",
            exec: { allow: ["ntn"], deny: ["rm"] },
            roomSessionScope: "shared",
            contextDir: "c",
            nudgeOnText: 1,
            nudgeMessage: "n",
            skipGlobalContext: true,
            summarizeOnTrim: true,
            worktree: true,
            taskPreamble: "t",
            injectMemory: true,
            budgetWarnings: true,
            memoryInjectBudgetTokens: 800,
            memoryInjectLimit: 5,
            hooks: {
              beforeRun: { tool: "recall", args: { q: "x" } },
              afterRun: [{ tool: "notes", onError: "continue" }],
            },
            sandbox: "docker",
            skills: ["notion"],
            skillLoading: "progressive",
            online: {
              enabled: true,
              cadence: { interval_minutes: 30, window: { start: "09:00", end: "17:00" } },
              budgets: { tokens_per_tick: 8000 },
              output: { notes: true, notify_owner: false },
              tools: ["recall"],
            },
            systemPrompt: { base: "b", order: ["instructions"], custom: [{ name: "x", content: "y" }] },
          },
        },
      }),
    );
    expect(issues).toEqual([]);
  });
});

describe("the field lists that used to drift", () => {
  it("covers every field a full agent block can carry", () => {
    // The three lists this replaces were hand-maintained copies of each other.
    // Adding a field to AgentDefinition and forgetting one of them made the
    // field inert — how `fileBoundary` and `injectMemory` came to do nothing.
    for (const key of ["fileBoundary", "injectMemory", "maxTokens", "exec", "systemPrompt"]) {
      expect(AGENT_DEFINITION_KEYS.has(key)).toBe(true);
    }
    expect(AGENT_DEFINITION_KEYS.has("system_prompt")).toBe(false);
  });

  it("still reports an unrecognized key with a suggestion", () => {
    const warnings = validateConfig(config({ agents: { writer: { temp: 0.3 } } }));
    expect(warnings.some((w) => w.includes('unknown key "temp"') && w.includes('Did you mean "temperature"'))).toBe(
      true,
    );
  });
});

describe("integration with the existing streams", () => {
  it("refuses a shape mistake at the write gate, not only at startup", () => {
    // findInertConfig is what config-write diffs to decide whether to write.
    // A warning printed at startup is a warning nobody reads six hours later.
    const issues = findInertConfig(config({ agents: { writer: { injectMemory: "true" } } }));
    expect(issues.some((i) => i.includes("`injectMemory`"))).toBe(true);
  });

  it("reports the same finding at startup", () => {
    const warnings = validateConfig(config({ agents: { writer: { injectMemory: "true" } } }));
    expect(warnings.some((i) => i.includes("`injectMemory`"))).toBe(true);
  });

  it("leaves a default config clean", () => {
    expect(findShapeIssues(config({}))).toEqual([]);
  });
});

/**
 * The walk covered `agents.<name>.*` — the per-agent overrides — and skipped
 * the global `agent:` block above it, where the deployment-wide defaults live.
 * Reproduced against a live config: a bad `temperature` on a named agent was
 * flagged, the same mistake on `agent.temperature` was not.
 */
describe("findShapeIssues — the global agent block", () => {
  it("catches a quoted maxTokens, which is truthy and reaches the wire", () => {
    // `if (params.maxTokens) { body.max_completion_tokens = params.maxTokens }`
    // — a non-empty string passes that guard.
    const issues = findShapeIssues(config({ agent: { maxTokens: "8192" } }));
    expect(issues.join("\n")).toContain("`maxTokens`");
    expect(issues.join("\n")).toContain("must be a number");
    expect(issues.join("\n")).toContain("Write `8192` without them");
  });

  it("catches the same mistakes it already caught one level down", () => {
    const named = findShapeIssues(config({ agents: { coder: { temperature: "warm" } } }));
    const global = findShapeIssues(config({ agent: { temperature: "warm" } }));
    expect(named).toHaveLength(1);
    expect(global).toHaveLength(1);
    expect(global[0]).toContain("`temperature`");
  });

  it("names the block it found the problem in", () => {
    const issues = findShapeIssues(config({ agent: { maxToolRounds: "10" } }));
    expect(issues[0]).toMatch(/^agent/);
  });

  it("validates the deployment fallback chain, not only per-agent chains", () => {
    const issues = findShapeIssues(config({ agent: { models: [{ provider: "local", model: 5 }] } }));
    // Indexed, so the rung is findable in a chain of five.
    expect(issues.join("\n")).toContain("`models.0.model` must be a string");
  });

  it("does not demand fields the loader fills in", () => {
    // Presence is not this checker's business — DEFAULT_CONFIG supplies the
    // rest, and "required" on a field nobody wrote would be pure noise.
    expect(findShapeIssues({ agent: { temperature: 0.3 } } as unknown as AgentConfig)).toEqual([]);
  });

  it("reaches the write gate, so a bad write is refused rather than warned about", () => {
    expect(findInertConfig(config({ agent: { maxTokens: "8192" } })).join("\n")).toContain("`maxTokens`");
  });
});

describe("findShapeIssues — other top-level blocks", () => {
  it("catches a quoted number in memory.embeddings", () => {
    const issues = findShapeIssues(config({ memory: { embeddings: { enabled: true, dim: "1024" } } }));
    expect(issues.join("\n")).toContain("`dim`");
  });

  it("catches a quoted flag in memory.embeddings", () => {
    const issues = findShapeIssues(config({ memory: { embeddings: { enabled: "false" } } }));
    expect(issues.join("\n")).toContain("currently reads as `true`");
  });

  it("catches a quoted number in memory.chunks", () => {
    expect(findShapeIssues(config({ memory: { chunks: { overlap: "200" } } })).join("\n")).toContain("`overlap`");
  });

  it("checks tasks.backend without judging the backend's own options bag", () => {
    expect(findShapeIssues(config({ tasks: { backend: 5 } })).join("\n")).toContain("`backend`");
    // `options` is the selected backend's business, per CLAUDE.md.
    expect(findShapeIssues(config({ tasks: { backend: "github", options: { repo: 5 } } }))).toEqual([]);
  });

  it("leaves valid blocks alone", () => {
    const issues = findShapeIssues(
      config({
        agent: { temperature: 0.3, maxTokens: 8192, models: [{ provider: "local", model: "m", thinking: "high" }] },
        memory: { embeddings: { enabled: true, dim: 1024 }, chunks: { overlap: 200 } },
        tasks: { backend: "native", options: { path: "/x" } },
      }),
    );
    expect(issues).toEqual([]);
  });
});
