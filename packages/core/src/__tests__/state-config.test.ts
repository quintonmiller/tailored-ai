/**
 * `state:` in config.
 *
 * Every warning here is a type that would parse and then quietly do something
 * other than what it says — the failure mode this codebase keeps producing.
 */
import { describe, expect, it } from "vitest";
import { type AgentConfig, normalizeRawConfig, validateConfig } from "../config.js";
import { findShapeIssues } from "../config-schema.js";

function config(raw: Record<string, unknown>): AgentConfig {
  return normalizeRawConfig(raw);
}

const stateWarnings = (raw: Record<string, unknown>) => validateConfig(config(raw)).filter((w) => w.includes("state"));

describe("state config", () => {
  it("is a known top-level key and defaults to the sqlite provider", () => {
    const cfg = config({ state: { types: [{ name: "plan" }] } });
    expect(validateConfig(cfg).filter((w) => w.toLowerCase().includes("unknown"))).toEqual([]);
    expect(stateWarnings({ state: { types: [{ name: "plan" }] } })).toEqual([]);
  });

  it("names schema keywords that are not enforced, so the gap is visible", () => {
    const warnings = stateWarnings({
      state: {
        types: [
          {
            name: "event",
            schema: { type: "object", properties: { when: { type: "string", format: "date-time" } }, oneOf: [] },
          },
        ],
      },
    });
    expect(warnings).toEqual([
      'state type "event": schema keyword(s) not enforced, so records are not checked against them: oneOf, when: format.',
    ]);
  });

  it("flags a pattern that will not compile, a title that is not a field, and a non-object schema", () => {
    const warnings = stateWarnings({
      state: {
        types: [
          {
            name: "a",
            title: "label",
            schema: { type: "object", properties: { code: { type: "string", pattern: "([" } } },
          },
          { name: "b", schema: { type: "array" } },
        ],
      },
    });
    expect(warnings).toEqual([
      'state type "a": pattern "([" does not compile, so it checks nothing.',
      'state type "a": title "label" is not one of its fields.',
      'state type "b": a record\'s data is an object, so schema.type must be "object".',
    ]);
  });

  it("flags a name nothing can address, and a duplicate", () => {
    const warnings = stateWarnings({ state: { types: [{ name: "Plans!" }, { name: "plan" }, { name: "plan" }] } });
    expect(warnings).toEqual([
      'state.types[0]: name must be lowercase snake_case (letters, digits, underscores, starting with a letter), got "Plans!".',
      'state.types[2]: "plan" is declared more than once; the last one wins.',
    ]);
  });

  it("catches a scope that is not one of the four, and a quoted access list", () => {
    const issues = findShapeIssues(
      config({ state: { types: [{ name: "plan", scope: "everywhere", access: { read: "*" } }] } }),
    );
    expect(issues).toEqual([
      'state: `types.0.scope` must be one of `global`, `room`, `agent`, `project`, got the string "everywhere".',
      'state: `types.0.access.read` must be an array, got the string "*".',
    ]);
  });

  it("accepts search fields, and flags ones that search nothing", () => {
    const schema = { type: "object", properties: { title: { type: "string" }, owner: { type: "object" } } };
    expect(
      stateWarnings({ state: { types: [{ name: "doc", schema, search: { fields: ["title", "owner.name"] } }] } }),
    ).toEqual([]);
    expect(
      stateWarnings({
        state: {
          types: [
            { name: "doc", schema, search: { fields: ["title", "body"] } },
            { name: "note", search: { fields: [] } },
          ],
        },
      }),
    ).toEqual([
      'state type "doc": search field "body" is not one of its fields, so it adds nothing.',
      'state type "note": search names no fields, so the type is not searchable.',
    ]);
    expect(findShapeIssues(config({ state: { types: [{ name: "doc", search: { fields: "title" } }] } }))).toEqual([
      'state: `types.0.search.fields` must be an array, got the string "title".',
    ]);
  });

  it("warns about a type named after one of the state routes", () => {
    expect(stateWarnings({ state: { types: [{ name: "search" }, { name: "events" }, { name: "plan" }] } })).toEqual([
      "state type \"search\": /api/state/search is a route of its own, so this type's records can't be listed over HTTP or on the State page; pick another name.",
      "state type \"events\": /api/state/events is a route of its own, so this type's records can't be listed over HTTP or on the State page; pick another name.",
    ]);
  });
});
