/**
 * Two read-only kinds. A progress component says how far along a job is and
 * is moved with `update`; a table shows the records a query matches as rows
 * and columns, filled and refreshed by core like a list.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComponentSpec, ToolOutput } from "../content/types.js";
import { tableProps } from "../interfaces/bind.js";
import { buildComponent, progressLines } from "../interfaces/kinds.js";
import { InterfaceStore } from "../interfaces/store.js";
import { type StateCaller, type StateConfig, StateService } from "../state/service.js";
import type { ToolContext } from "../tools/interface.js";
import { InterfaceTool } from "../tools/interface-tool.js";

const stateConfig: StateConfig = {
  backend: "sqlite",
  types: [
    {
      name: "bill",
      title: "payee",
      schema: {
        type: "object",
        required: ["payee"],
        properties: { payee: { type: "string" }, amount: { type: "number" }, due: { type: "string" } },
      },
    },
  ],
};
const system: StateCaller = { actor: { kind: "system", name: "test" } };

let state: StateService;
let store: InterfaceStore;
let tool: InterfaceTool;

beforeEach(async () => {
  const db = new Database(":memory:");
  let clock = Date.parse("2026-10-18T09:00:00Z");
  state = new StateService({ getConfig: () => ({ state: stateConfig }), db, now: () => new Date((clock += 1000)) });
  store = new InterfaceStore(db);
  tool = new InterfaceTool(
    () => store,
    () => state,
  );
  await state.put(system, {
    type: "bill",
    id: "power",
    scope: "global",
    data: { amount: 84.2, payee: "Power co", due: "2026-11-01" },
  });
  await state.put(system, {
    type: "bill",
    id: "water",
    scope: "global",
    data: { amount: 31, payee: "Water", due: "2026-11-09" },
  });
});

afterEach(async () => {
  await state.close();
});

const context: ToolContext = { sessionId: "s1", workingDirectory: "/tmp", env: {}, agentName: "planner" };
const sent = (output: ToolOutput): ComponentSpec => {
  if (typeof output === "string") throw new Error(`expected parts, got: ${output}`);
  const part = output.parts.find((p) => p.type === "component");
  if (part?.type !== "component") throw new Error("no component");
  return part.component;
};

describe("progress", () => {
  it("reads as a count with a percentage, as steps, or as working", () => {
    expect(progressLines({ label: "Import", value: 3, max: 6 })).toEqual(["3 of 6 (50%)"]);
    expect(progressLines({ label: "Import", value: 40 })).toEqual(["40%"]);
    expect(progressLines({ label: "Trip", steps: ["Book", "Pack", "Go"], done: 1 })).toEqual([
      "✓ Book",
      "→ Pack",
      "· Go",
    ]);
    expect(progressLines({ label: "Thinking" })).toEqual(["Working…"]);
  });

  it("is sent once and moved along with update, keeping its id", async () => {
    const first = await tool.execute(
      { action: "send", kind: "progress", props: { label: "Importing photos", value: 0, max: 120 } },
      context,
    );
    const spec = sent(first.output);
    expect(spec.fallback).toBe(`[progress ${spec.id}] Importing photos\n0 of 120 (0%)`);

    const moved = await tool.execute(
      {
        action: "update",
        id: spec.id,
        props: { label: "Importing photos", value: 90, max: 120, note: "Almost there" },
      },
      context,
    );
    expect(sent(moved.output)).toMatchObject({ id: spec.id, props: { value: 90 } });
    expect(store.get(spec.id)?.spec.fallback).toBe(
      `[progress ${spec.id}] Importing photos\n90 of 120 (75%)\nAlmost there`,
    );
  });

  it("counts finished steps from `done`, from `step` as the tool hears it, or from a value sent with the steps", async () => {
    // A local model tracked steps through `value` one run in three, and named
    // the field `step` by habit; both now mean "this many are finished".
    expect(progressLines({ label: "Trip", steps: ["Book", "Pack", "Go"], value: 2, max: 3 })).toEqual([
      "✓ Book",
      "✓ Pack",
      "→ Go",
    ]);
    const res = await tool.execute(
      { action: "send", kind: "progress", props: { label: "Trip", steps: ["Book", "Pack", "Go"], step: 1 } },
      context,
    );
    expect(sent(res.output).props).toEqual({ label: "Trip", steps: ["Book", "Pack", "Go"], done: 1 });
  });

  it("refuses a value that cannot be progress", () => {
    expect(() => buildComponent({ kind: "progress", props: { label: "x", value: -1 } })).toThrow("value");
    expect(() => buildComponent({ kind: "progress", props: { label: "x", steps: [] } })).toThrow("steps");
  });
});

describe("table", () => {
  it("fills its rows from the query: the title field first, then the other fields", async () => {
    const res = await tool.execute(
      { action: "send", kind: "table", props: { title: "Bills" }, bind: { type: "bill" } },
      context,
    );
    expect(res.success).toBe(true);
    const spec = sent(res.output);
    expect(spec.props.columns).toEqual(["payee", "amount", "due"]);
    expect(spec.props.rows).toEqual([
      { id: "power", cells: ["Power co", "84.2", "2026-11-01"] },
      { id: "water", cells: ["Water", "31", "2026-11-09"] },
    ]);
    expect(spec.query).toEqual({ type: "bill", scopes: ["agent:planner", "global"] });
    expect(spec.fallback).toBe(
      `[table ${spec.id}] Bills\n| payee | amount | due |\n|---|---|---|\n| Power co | 84.2 | 2026-11-01 |\n| Water | 31 | 2026-11-09 |`,
    );
  });

  it("keeps the agent's columns, and keeps them on update with the rows as they are now", async () => {
    const res = await tool.execute(
      { action: "send", kind: "table", props: { columns: ["due", "payee"] }, bind: { type: "bill", limit: 1 } },
      context,
    );
    const spec = sent(res.output);
    expect(spec.props).toMatchObject({
      title: "bill",
      columns: ["due", "payee"],
      rows: [{ id: "power", cells: ["2026-11-01", "Power co"] }],
      more: 1,
    });

    await state.patch(system, { type: "bill", id: "power" }, { due: "2026-11-03" });
    const updated = sent((await tool.execute({ action: "update", id: spec.id }, context)).output);
    expect(updated.props).toMatchObject({
      columns: ["due", "payee"],
      rows: [{ id: "power", cells: ["2026-11-03", "Power co"] }],
    });
  });

  it("is redrawn within the scopes its agent could see", async () => {
    await state.put(system, { type: "bill", id: "secret", scope: "agent:someone-else", data: { payee: "Hidden" } });
    const props = await tableProps(state, system, { title: "Bills" }, { type: "bill", scopes: ["global"] });
    expect((props.rows as { id: string }[]).map((r) => r.id)).toEqual(["power", "water"]);
  });
});
