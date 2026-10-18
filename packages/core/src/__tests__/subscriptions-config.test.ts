/**
 * `subscriptions:` in config. Each warning is a subscription that would sit in
 * config looking active and never deliver anything.
 */
import { describe, expect, it } from "vitest";
import { type AgentConfig, normalizeRawConfig, validateConfig } from "../config.js";
import { findShapeIssues } from "../config-schema.js";

function config(raw: Record<string, unknown>): AgentConfig {
  return normalizeRawConfig({ agents: { planner: { description: "plans" } }, ...raw });
}

const warningsFor = (subscriptions: unknown[]) =>
  validateConfig(config({ subscriptions })).filter((w) => w.startsWith("subscriptions"));

describe("subscriptions config", () => {
  it("accepts a well-formed subscription of each kind without a word", () => {
    expect(
      warningsFor([
        { agent: "planner", on: "state.changed", when: { type: "plan" }, deliver: "immediate" },
        { agent: "planner", on: "state.changed", deliver: "batch", window: "5m" },
        { agent: "planner", on: "task.created", deliver: "digest", every: "weekdays at 9am" },
        { agent: "planner", on: "state.changed", deliver: "record", target: { room: "local:eng" } },
      ]),
    ).toEqual([]);
    expect(validateConfig(config({ subscriptions: [] })).filter((w) => w.toLowerCase().includes("unknown"))).toEqual(
      [],
    );
  });

  it("names an unknown agent and an event nothing emits, with the near miss", () => {
    expect(warningsFor([{ agent: "plannr", on: "state.change" }])).toEqual([
      'subscriptions[0] (plannr on state.change): unknown agent "plannr" — it will never be woken',
      'subscriptions[0] (plannr on state.change): "state.change" is not a runtime event, so this subscription will never fire. Did you mean "state.changed"?',
    ]);
    expect(warningsFor([{ agent: "planner", on: "tasks.created" }])[0]).toContain('Did you mean "task.created"?');
  });

  it("refuses a waterfall event, which can be refused but cannot wake anyone", () => {
    expect(warningsFor([{ agent: "planner", on: "agent.pre_tool_use" }])).toEqual([
      'subscriptions[0] (planner on agent.pre_tool_use): "agent.pre_tool_use" is a waterfall event a hook can refuse, not one an agent can be woken by.',
    ]);
  });

  it("flags a batch with no usable window and a digest with no usable schedule", () => {
    expect(
      warningsFor([
        { agent: "planner", on: "state.changed", deliver: "batch" },
        { agent: "planner", on: "state.changed", deliver: "batch", window: "a while" },
        { agent: "planner", on: "state.changed", deliver: "digest", every: "whenever" },
        { agent: "planner", on: "state.changed", deliver: "immediate", window: "5m", every: "hourly" },
      ]),
    ).toEqual([
      'subscriptions[0] (planner on state.changed): deliver "batch" needs a "window", e.g. "5m"; it will not run.',
      'subscriptions[1] (planner on state.changed): window "a while" is not a duration like "5m" or "30 seconds"; it will not run.',
      'subscriptions[2] (planner on state.changed): every "whenever" is not a schedule this understands; it will not run.',
      'subscriptions[3] (planner on state.changed): "window" only applies to deliver "batch" and is ignored here.',
      'subscriptions[3] (planner on state.changed): "every" only applies to deliver "digest" and is ignored here.',
    ]);
  });

  it("flags a target room that is neither declared nor a ref, and a duplicate", () => {
    expect(
      warningsFor([
        { agent: "planner", on: "state.changed", target: { room: "nowhere" } },
        { agent: "planner", on: "state.changed", target: { room: "nowhere" } },
      ]),
    ).toEqual([
      'subscriptions[0] (planner on state.changed): target room "nowhere" is neither a room declared in rooms.rooms nor a <backend>:<id> ref',
      'subscriptions[1] (planner on state.changed): target room "nowhere" is neither a room declared in rooms.rooms nor a <backend>:<id> ref',
      "subscriptions[1] (planner on state.changed): duplicates an earlier subscription, so the agent hears everything twice.",
    ]);
  });

  it("catches a delivery mode that is not one of the five", () => {
    const issues = findShapeIssues(
      config({ subscriptions: [{ agent: "planner", on: "state.changed", deliver: "soon" }] }),
    );
    expect(issues).toEqual([
      'subscriptions: `0.deliver` must be one of `immediate`, `queue`, `batch`, `digest`, `record`, got the string "soon".',
    ]);
  });
});
