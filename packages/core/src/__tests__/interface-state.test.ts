/**
 * Components and world state: a card bound to a record, and buttons that
 * write to one.
 *
 * Two properties matter. A state button is not an answer: it writes as the
 * person who clicked, no model turn runs, and the component stays open for
 * the next click. And a bound card shows the record as the agent could read
 * it, so binding never shows an agent something its own `state` tool would
 * not.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolOutput } from "../content/types.js";
import { boundCardProps } from "../interfaces/bind.js";
import { buildComponent, InterfaceError } from "../interfaces/kinds.js";
import { respondToComponent } from "../interfaces/respond.js";
import { InterfaceStore } from "../interfaces/store.js";
import { type StateCaller, type StateConfig, StateService } from "../state/service.js";
import type { ToolContext } from "../tools/interface.js";
import { InterfaceTool } from "../tools/interface-tool.js";

const stateConfig: StateConfig = {
  backend: "sqlite",
  types: [
    {
      name: "plan",
      title: "name",
      schema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, status: { type: "string", enum: ["draft", "active", "done"] } },
      },
    },
    { name: "private", scope: "agent" },
  ],
};

const system: StateCaller = { actor: { kind: "system", name: "test" } };

let db: Database.Database;
let store: InterfaceStore;
let state: StateService;
let tool: InterfaceTool;

beforeEach(async () => {
  db = new Database(":memory:");
  store = new InterfaceStore(db);
  state = new StateService({ getConfig: () => ({ state: stateConfig }), db });
  tool = new InterfaceTool(
    () => store,
    () => state,
  );
  await state.put(system, {
    type: "plan",
    id: "trip",
    scope: "global",
    data: { name: "Lisbon trip", status: "draft" },
  });
});

afterEach(async () => {
  await state.close();
});

const context: ToolContext = { sessionId: "s1", workingDirectory: "/tmp", env: {}, agentName: "planner" };
const run = (args: Record<string, unknown>) => tool.execute(args, context);
const sentSpec = (output: ToolOutput) => {
  if (typeof output === "string") throw new Error(`expected parts, got: ${output}`);
  const part = output.parts.find((p) => p.type === "component");
  if (part?.type !== "component") throw new Error("no component in the output");
  return part.component;
};

describe("building a state button", () => {
  it("writes to the bound record unless the button names its own", () => {
    const spec = buildComponent({
      kind: "card",
      props: { title: "Trip" },
      bind: { type: "plan", id: "trip" },
      actions: [
        { label: "Start", effect: "state", patch: { status: "active" } },
        { label: "Other", effect: "state", patch: { status: "done" }, ref: { type: "plan", id: "move" } },
      ],
    });
    expect(spec.bind).toEqual({ type: "plan", id: "trip" });
    expect(spec.actions?.map((a) => a.effect)).toEqual([
      { kind: "state", ref: { type: "plan", id: "trip" }, patch: { status: "active" } },
      { kind: "state", ref: { type: "plan", id: "move" }, patch: { status: "done" } },
    ]);
  });

  it("refuses a state button with nothing to write or nowhere to write it", () => {
    const card = (actions: unknown[], bind?: { type: string; id: string }) => () =>
      buildComponent({ kind: "card", props: { title: "T" }, actions: actions as never, ...(bind ? { bind } : {}) });
    expect(card([{ label: "Go", effect: "state" }], { type: "plan", id: "trip" })).toThrow('needs a "patch"');
    expect(card([{ label: "Go", effect: "state", patch: { status: "done" } }])).toThrow("names no record");
  });

  it("binds only a card", () => {
    expect(() =>
      buildComponent({ kind: "confirm", props: { summary: "Go?" }, bind: { type: "plan", id: "trip" } }),
    ).toThrow("`bind` is for a card");
  });
});

describe("boundCardProps", () => {
  const record = (data: Record<string, unknown>) => ({
    type: "plan",
    id: "trip",
    scope: "global",
    data,
    version: 1,
    createdAt: "",
    updatedAt: "",
    updatedBy: system.actor,
  });

  it("names the card from the record's title field, and lists every other field", () => {
    expect(
      boundCardProps({ title: "Old name", body: "Ours" }, record({ name: "Lisbon", nights: 4, tags: ["a"] }), "name"),
    ).toEqual({
      title: "Lisbon",
      body: "Ours",
      fields: [
        { label: "nights", value: "4" },
        { label: "tags", value: '["a"]' },
      ],
    });
  });

  it("falls back to the agent's title, then to the record's type and id", () => {
    expect(boundCardProps({ title: "Mine" }, record({ status: "draft" }), undefined).title).toBe("Mine");
    expect(boundCardProps({}, record({ status: "draft" }), undefined).title).toBe("plan trip");
  });

  it("shows only the fields its binding names, in that order, and the one it names as its text", () => {
    const data = { name: "Lisbon", status: "draft", nights: 4, summary: "A week by the sea", token: "x1" };
    expect(
      boundCardProps({ title: "T" }, record(data), "name", { fields: ["nights", "status", "gone"], body: "summary" }),
    ).toEqual({
      title: "Lisbon",
      body: "A week by the sea",
      fields: [
        { label: "nights", value: "4" },
        { label: "status", value: "draft" },
      ],
    });
    // Its text named and no fields: every other field, but not its text again.
    expect(
      boundCardProps({}, record({ name: "L", summary: "S", status: "draft" }), "name", { body: "summary" }),
    ).toEqual({ title: "L", body: "S", fields: [{ label: "status", value: "draft" }] });
    expect(boundCardProps({}, record({ name: "L", status: "draft" }), "name", { fields: [] })).toEqual({ title: "L" });
  });
});

describe("a card naming which of its record's fields it shows", () => {
  it("keeps what it names on the card, so it shows the same however often it is redrawn", async () => {
    await state.patch(system, { type: "plan", id: "trip" }, { note: "Pack light." });
    const sent = await run({
      action: "send",
      kind: "card",
      bind: { type: "plan", id: "trip", fields: ["status"], body: "note" },
    });
    expect(sent.success, sent.error).toBe(true);
    const spec = sentSpec(sent.output);
    expect(spec.bind).toEqual({ type: "plan", id: "trip", fields: ["status"], body: "note" });
    expect(spec.props).toEqual({
      title: "Lisbon trip",
      body: "Pack light.",
      fields: [{ label: "status", value: "draft" }],
    });
    const updated = await run({ action: "update", id: spec.id, props: {} });
    expect(updated.success, updated.error).toBe(true);
    expect(store.get(spec.id)?.spec.bind).toEqual(spec.bind);
    expect(store.get(spec.id)?.spec.props.body).toBe("Pack light.");
    const wrong = await run({ action: "send", kind: "card", bind: { type: "plan", id: "trip", fields: [1] } });
    expect(wrong.error).toMatch(/`bind.fields` is a list/);
  });
});

describe("pressing a state button", () => {
  const card = () => {
    const spec = buildComponent({
      kind: "card",
      props: { title: "Trip" },
      bind: { type: "plan", id: "trip" },
      actions: [
        { label: "Start", effect: "state", patch: { status: "active" } },
        { label: "Finish", effect: "state", patch: { status: "done" } },
      ],
    });
    store.create(spec, "planner", "s1");
    return spec;
  };
  const press = (id: string, actionId: string, opts = { state, surface: "web" }) =>
    respondToComponent(store, undefined, { id, actionId, by: "owner" }, opts);

  it("writes as the person, says where from, and leaves the component open for the next click", async () => {
    const spec = card();
    const first = await press(spec.id, "a1");
    expect(first).toMatchObject({ effect: "state", record: { data: { status: "active" }, version: 2 } });
    expect(store.get(spec.id)?.status).toBe("open");

    await press(spec.id, "a2");
    const [latest] = await state.history(system, { type: "plan", id: "trip" });
    expect(latest).toMatchObject({
      op: "update",
      actor: { kind: "user", name: "owner" },
      source: { surface: "web", interfaceId: spec.id },
      after: { name: "Lisbon trip", status: "done" },
    });
  });

  it("is refused once the component is closed, and says why when the write does not fit", async () => {
    const spec = buildComponent({
      kind: "card",
      props: { title: "Trip" },
      bind: { type: "plan", id: "trip" },
      actions: [{ label: "Break it", effect: "state", patch: { status: "lost" } }],
    });
    store.create(spec, "planner", "s1");
    await expect(press(spec.id, "a1")).rejects.toThrow(InterfaceError);
    await expect(press(spec.id, "a1")).rejects.toThrow("status");

    store.close(spec.id);
    await expect(press(spec.id, "a1")).rejects.toThrow("This was closed by the agent.");
  });

  it("is refused where state is not available", async () => {
    const spec = card();
    await expect(press(spec.id, "a1", {} as never)).rejects.toThrow("state is not available here");
  });
});

describe("the interface tool and bound cards", () => {
  it("fills a bound card from the record, and tells the agent no answer comes back for state buttons", async () => {
    const res = await run({
      action: "send",
      kind: "card",
      bind: { type: "plan", id: "trip" },
      actions: [{ label: "Start", effect: "state", patch: { status: "active" } }],
    });
    expect(res.success).toBe(true);
    const spec = sentSpec(res.output);
    expect(spec.props).toEqual({ title: "Lisbon trip", fields: [{ label: "status", value: "draft" }] });
    expect(spec.fallback).toContain("status: draft");
    expect(typeof res.output !== "string" && res.output.parts[0]).toEqual({
      type: "text",
      text: `Sent card ${spec.id}. Its state buttons write the record directly; no message comes back to you.`,
    });
  });

  it("accepts bind as the JSON text small models send", async () => {
    const res = await run({ action: "send", kind: "card", bind: '{"type":"plan","id":"trip"}' });
    expect(res.success).toBe(true);
  });

  it("refuses a record the agent could not read, and a kind that cannot bind", async () => {
    await state.put(system, { type: "private", id: "secret", scope: "agent:someone-else", data: { x: 1 } });
    const hidden = await run({ action: "send", kind: "card", bind: { type: "private", id: "secret" } });
    expect(hidden).toMatchObject({ success: false, error: 'There is no private record "secret" you can see.' });

    const confirm = await run({
      action: "send",
      kind: "confirm",
      props: { summary: "Go?" },
      bind: { type: "plan", id: "trip" },
    });
    expect(confirm.error).toContain("`bind` is for a card");

    const noId = await run({ action: "send", kind: "card", bind: { type: "plan" } });
    expect(noId.error).toContain("needs a record's `type` and `id`");
  });

  it("uses the record's fields over ones the agent copied in, and says so instead of refusing", async () => {
    // A local model copied the record into `fields` on every run.
    const res = await run({
      action: "send",
      kind: "card",
      props: { title: "Trip", fields: [{ label: "Status", value: "stale" }] },
      bind: { type: "plan", id: "trip" },
    });
    expect(res.success).toBe(true);
    const spec = sentSpec(res.output);
    expect(spec.props.fields).toEqual([{ label: "status", value: "draft" }]);
    expect(typeof res.output !== "string" && res.output.parts[0]).toMatchObject({
      text: expect.stringContaining("the fields you gave were left out"),
    });
  });

  it("lifts buttons put inside props, so a bound card does not lose them", async () => {
    // Two runs in three on a local model; before, the card went out with no buttons.
    const res = await run({
      action: "send",
      kind: "card",
      bind: { type: "plan", id: "trip" },
      props: { actions: [{ label: "Start", effect: "state", patch: { status: "active" } }] },
    });
    expect(res.success).toBe(true);
    expect(sentSpec(res.output).actions).toEqual([
      {
        id: "a1",
        label: "Start",
        effect: { kind: "state", ref: { type: "plan", id: "trip" }, patch: { status: "active" } },
      },
    ]);
  });

  it("still refuses a prop the card does not have, bound or not", async () => {
    const res = await run({
      action: "send",
      kind: "card",
      bind: { type: "plan", id: "trip" },
      props: { colour: "red" },
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("colour");
  });

  it("keeps the binding on update and shows the record as it is now", async () => {
    const sent = sentSpec((await run({ action: "send", kind: "card", bind: { type: "plan", id: "trip" } })).output);
    await state.patch(system, { type: "plan", id: "trip" }, { status: "active" });
    const updated = await run({ action: "update", id: sent.id });
    expect(updated.success).toBe(true);
    const spec = sentSpec(updated.output);
    expect(spec.bind).toEqual({ type: "plan", id: "trip" });
    expect(spec.props.fields).toEqual([{ label: "status", value: "active" }]);
  });
});
