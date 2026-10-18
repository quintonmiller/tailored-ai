/**
 * A list: the records a world-state query matches, as a checklist an agent
 * sends once and a person ticks.
 *
 * The rules that matter: the items are what the agent could read, then and on
 * every redraw; a tick flips the named field as the person who ticked, with no
 * model turn; and only a record the query still matches can be ticked.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComponentSpec, ToolOutput } from "../content/types.js";
import { listProps } from "../interfaces/bind.js";
import { respondToComponent } from "../interfaces/respond.js";
import { InterfaceStore } from "../interfaces/store.js";
import { WAKE_ROOMS_KEY } from "../rooms/keys.js";
import { type StateCaller, type StateConfig, StateService } from "../state/service.js";
import type { ToolContext } from "../tools/interface.js";
import { InterfaceTool } from "../tools/interface-tool.js";

const stateConfig: StateConfig = {
  backend: "sqlite",
  types: [
    {
      name: "chore",
      title: "name",
      schema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          done: { type: "boolean" },
          status: { type: "string", enum: ["open", "finished"] },
          room: { type: "string" },
        },
      },
    },
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
  // A clock that moves a second per write, so "oldest first" is never a tie.
  let clock = Date.parse("2026-10-18T09:00:00Z");
  state = new StateService({ getConfig: () => ({ state: stateConfig }), db, now: () => new Date((clock += 1000)) });
  tool = new InterfaceTool(
    () => store,
    () => state,
  );
  for (const [id, name, done] of [
    ["dishes", "Do the dishes", false],
    ["bins", "Take out the bins", true],
    ["plants", "Water the plants", false],
  ] as const) {
    await state.put(system, { type: "chore", id, scope: "global", data: { name, done, room: "kitchen" } });
  }
});

afterEach(async () => {
  await state.close();
});

const context = (rooms = ""): ToolContext => ({
  sessionId: "s1",
  workingDirectory: "/tmp",
  env: {},
  agentName: "planner",
  workingMemory: new Map(rooms ? [[WAKE_ROOMS_KEY, rooms]] : []),
});
const run = (args: Record<string, unknown>, ctx = context()) => tool.execute(args, ctx);
const sent = (output: ToolOutput): ComponentSpec => {
  if (typeof output === "string") throw new Error(`expected parts, got: ${output}`);
  const part = output.parts.find((p) => p.type === "component");
  if (part?.type !== "component") throw new Error("no component");
  return part.component;
};
const sendChores = async (extra: Record<string, unknown> = {}) => {
  const res = await run({
    action: "send",
    kind: "list",
    props: { title: "Chores", check: { field: "done" } },
    bind: { type: "chore" },
    ...extra,
  });
  expect(res.success).toBe(true);
  return { res, spec: sent(res.output) };
};

describe("sending a list", () => {
  it("fills the items from the query, ticked where the check field is on", async () => {
    const { res, spec } = await sendChores();
    expect(spec.props.items).toEqual([
      { id: "dishes", label: "Do the dishes", checked: false },
      { id: "bins", label: "Take out the bins", checked: true },
      { id: "plants", label: "Water the plants", checked: false },
    ]);
    expect(spec.query).toEqual({ type: "chore", scopes: ["agent:planner", "global"] });
    expect(spec.fallback).toBe(
      `[list ${spec.id}] Chores\n- [ ] Do the dishes\n- [x] Take out the bins\n- [ ] Water the plants`,
    );
    expect(typeof res.output !== "string" && res.output.parts[0]).toEqual({
      type: "text",
      text: `Sent list ${spec.id}. Ticking an item flips its done directly; no message comes back to you.`,
    });
  });

  it("filters with `where`, caps at `limit`, and counts the rest", async () => {
    const { spec } = await sendChores({ bind: { type: "chore", where: { done: false }, limit: 1 } });
    expect(spec.props.items).toEqual([{ id: "dishes", label: "Do the dishes", checked: false }]);
    expect(spec.props.more).toBe(1);
    expect(spec.fallback).toContain("…and 1 more.");
  });

  it("shows only what the agent could read, and remembers those scopes for later redraws", async () => {
    await state.put(system, { type: "chore", id: "secret", scope: "agent:someone-else", data: { name: "Hidden" } });
    await state.put(system, { type: "chore", id: "here", scope: "room:local:eng", data: { name: "Room chore" } });
    const { spec } = await sendChores();
    expect((spec.props.items as { id: string }[]).map((i) => i.id)).not.toContain("secret");
    expect((spec.props.items as { id: string }[]).map((i) => i.id)).not.toContain("here");

    const inRoom = sent(
      (await run({ action: "send", kind: "list", bind: { type: "chore" } }, context("local:eng"))).output,
    );
    expect((inRoom.props.items as { id: string }[]).map((i) => i.id)).toContain("here");
    expect(inRoom.query?.scopes).toEqual(["room:local:eng", "agent:planner", "global"]);
    expect(inRoom.props.title).toBe("chore");

    // A redraw later reads as the system, narrowed to those scopes.
    const redrawn = await listProps(state, system, inRoom.props, inRoom.query as never);
    expect((redrawn.items as { id: string }[]).map((i) => i.id)).not.toContain("secret");
  });

  it("refuses a list with no records to show, and a check with no field", async () => {
    const noBind = await run({ action: "send", kind: "list", props: { title: "Chores" } });
    expect(noBind.error).toContain("give `bind` with the record type");
    const noField = await run({
      action: "send",
      kind: "list",
      bind: { type: "chore" },
      props: { check: { on: true } },
    });
    expect(noField.error).toContain("`check` needs the `field`");
  });

  it("takes a check given beside props, as small models put it", async () => {
    const res = await run({ action: "send", kind: "list", bind: { type: "chore" }, check: { field: "done" } });
    expect(sent(res.output).props.check).toEqual({ field: "done" });
  });

  it("keeps its query and check on update, with the items as they are now", async () => {
    const { spec } = await sendChores();
    await state.patch(system, { type: "chore", id: "dishes" }, { done: true });
    const updated = await run({ action: "update", id: spec.id });
    expect(updated.success).toBe(true);
    const now = sent(updated.output);
    expect(now.query).toEqual(spec.query);
    expect(now.props.check).toEqual({ field: "done" });
    expect(now.props.items).toContainEqual({ id: "dishes", label: "Do the dishes", checked: true });
  });
});

describe("ticking an item", () => {
  const tick = (id: string, recordId: string, by = "owner") =>
    respondToComponent(store, undefined, { id, actionId: `check:${recordId}`, by }, { state, surface: "web" });

  it("flips the field as the person who ticked, and leaves the list open", async () => {
    const { spec } = await sendChores();
    expect(await tick(spec.id, "dishes")).toMatchObject({ effect: "state", record: { data: { done: true } } });
    expect(await tick(spec.id, "dishes")).toMatchObject({ effect: "state", record: { data: { done: false } } });
    expect(store.get(spec.id)?.status).toBe("open");
    const [latest] = await state.history(system, { type: "chore", id: "dishes" });
    expect(latest).toMatchObject({
      actor: { kind: "user", name: "owner" },
      source: { surface: "web", interfaceId: spec.id },
    });
  });

  it("uses the check's own on and off values", async () => {
    const { spec } = await sendChores({
      props: { title: "Chores", check: { field: "status", on: "finished", off: "open" } },
    });
    expect(await tick(spec.id, "bins")).toMatchObject({ record: { data: { status: "finished" } } });
    expect(await tick(spec.id, "bins")).toMatchObject({ record: { data: { status: "open" } } });
  });

  it("refuses a record the list's query no longer matches, or never could see", async () => {
    const { spec } = await sendChores({ bind: { type: "chore", where: { done: false } } });
    await state.patch(system, { type: "chore", id: "plants" }, { done: true });
    await expect(tick(spec.id, "plants")).rejects.toThrow("That item is no longer on this list.");

    await state.put(system, {
      type: "chore",
      id: "secret",
      scope: "agent:someone-else",
      data: { name: "Hidden", done: false },
    });
    await expect(tick(spec.id, "secret")).rejects.toThrow("That item is no longer on this list.");
  });

  it("is refused once the list is closed", async () => {
    const { spec } = await sendChores();
    store.close(spec.id);
    await expect(tick(spec.id, "dishes")).rejects.toThrow("This was closed by the agent.");
  });
});
