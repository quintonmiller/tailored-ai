/**
 * A commitment's `nextCheck`, read as a time or a change to watch for: the
 * forms, the time zone they're read in, what the `commitment` tool says it
 * made of one, the note it stays when it's neither, and a person's edit on
 * the State page or a room's page, which the directory reads again.
 *
 * The plugin is loaded the way the CLI loads it, against the real rooms store
 * and a world-state service that emits `state.changed` on the runtime's bus,
 * and its tools are built from the tool-factory registry the way
 * `createTools()` builds them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearContextSlots } from "../agent/context-slots.js";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import { HttpRouteRegistry } from "../http/registry.js";
import { createPluginContext } from "../plugin-context.js";
import * as directoryPlugin from "../plugins/directory.js";
import { BACKSTOP_MS, checkSaid, parseEvent, readCheck } from "../plugins/directory-checks.js";
import { COMMITMENT_TYPE } from "../plugins/directory-records.js";
import { type LoadedPlugin, loadPlugins } from "../plugins.js";
import { RoomStore } from "../rooms/store.js";
import type { AgentRuntime } from "../runtime.js";
import { type StateCaller, StateService } from "../state/service.js";
import type { StateTypeDef } from "../state/types.js";
import type { Tool } from "../tools/interface.js";
import { toolFactoryRegistry } from "../tools/tool-factories.js";

const PERSON: StateCaller = { actor: { kind: "user", name: "owner" }, source: { surface: "web" } };
/** Thursday 22 October 2026, 10:00 UTC: 11:00 in Lisbon, which is on summer time until the 25th. */
const NOW = new Date("2026-10-22T10:00:00.000Z");
const LISBON = "Europe/Lisbon";
const TRAVEL = "local:travel";

/** A type only the planner may read, for a change another agent can't watch. */
const PLAN: StateTypeDef = { name: "plan", description: "Plans.", scope: "global", access: { read: ["planner"] } };

let db: ReturnType<typeof initDatabase>;
let events: TypedEventBus;
let service: StateService;
let store: RoomStore;
let routes: HttpRouteRegistry;
let agents: Record<string, { description?: string; tools?: string[] }>;
let zone: string;
let loaded: LoadedPlugin[];

function fakeRuntime(): AgentRuntime {
  return {
    getConfig: () => ({ agents }),
    getAgentRegistry: () => ({ list: () => [] }),
    getAgentDefinition: (name: string) => agents[name],
    getStateService: () => service,
    getHttpRoutes: () => routes,
    getRoomStore: () => store,
    getTimeProvider: () => ({ now: () => NOW, timeZone: () => zone }),
  } as unknown as AgentRuntime;
}

async function load(config: Record<string, unknown> = { leads: { travel: "trip-planner" } }): Promise<void> {
  const [plugin] = await loadPlugins(
    { plugins: [{ module: "builtin:directory", enabled: true, config }] } as never,
    async () => directoryPlugin,
    { context: createPluginContext({ runtime: fakeRuntime(), events }) },
  );
  expect(plugin.ok).toBe(true);
  loaded.push(plugin);
}

function build(name: string): Tool {
  const factory = toolFactoryRegistry.get(name);
  if (!factory) throw new Error(`no ${name} tool registered`);
  const [tool] = factory({} as never, { getStateService: () => service });
  return tool;
}

async function run(agent: string, args: Record<string, unknown>): Promise<string> {
  const result = await build("commitment").execute(args, {
    sessionId: "s",
    workingDirectory: "/",
    env: {},
    agentName: agent,
  });
  if (!result.success) throw new Error(`commitment ${JSON.stringify(args)} failed: ${result.error}`);
  return String(result.output);
}

const commitment = async (id: string) => (await service.get(PERSON, { type: COMMITMENT_TYPE, id }))?.data ?? {};

/** What the directory's listeners do after a write lands: they read and write on, so let them finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function http(method: string, path: string, params: Record<string, string>, body: unknown) {
  const r = routes.list().find((x) => x.method === method && x.mountPath === `/api/ext/builtin:directory/${path}`);
  if (!r) throw new Error(`no route ${method} ${path}`);
  const res = await r.handler({
    method,
    path: r.mountPath,
    params,
    query: {},
    headers: {},
    json: async () => body as never,
    text: async () => JSON.stringify(body),
  });
  return { status: res.status ?? 200, json: res.json as Record<string, unknown> };
}

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  db = initDatabase(":memory:");
  events = new TypedEventBus();
  service = new StateService({ getConfig: () => ({ state: { backend: "sqlite", types: [PLAN] } }), db, events });
  store = new RoomStore(db);
  routes = new HttpRouteRegistry();
  agents = { planner: {}, "trip-planner": {}, writer: {} };
  zone = LISBON;
  loaded = [];
  store.upsertRoom({ ref: { backend: "local", id: "travel" }, name: "travel", purpose: "Family trips." }, "alex");
  store.subscribe({ agent: "trip-planner", roomRef: TRAVEL, source: "config" });
  store.subscribe({ agent: "planner", roomRef: TRAVEL, source: "config" });
  await load();
});

afterEach(async () => {
  for (const plugin of loaded) await plugin.stop?.();
  clearContextSlots();
  vi.restoreAllMocks();
});

describe("reading a nextCheck", () => {
  const read = (text: string, timeZone = LISBON, canRead = (_type: string) => true) =>
    readCheck(text, { now: NOW, timeZone, canRead });

  it.each([
    // The weekday, a duration and a date, each in the runtime's zone.
    ["Friday 9am", "2026-10-23T08:00:00.000Z", false],
    ["in 2 days", "2026-10-24T10:00:00.000Z", false],
    // After the clocks go back on the 25th, Lisbon is on UTC.
    ["2026-10-28", "2026-10-28T09:00:00.000Z", true],
    ["tomorrow 5pm", "2026-10-23T16:00:00.000Z", false],
  ])("reads %s as a time", (text, iso, defaulted) => {
    expect(read(text)).toEqual({ kind: "time", at: new Date(iso), defaultedTime: defaulted });
  });

  it("reads the same words in another zone as another moment", () => {
    const check = read("Friday 9am", "America/Los_Angeles");
    expect(check.kind === "time" && check.at.toISOString()).toBe("2026-10-23T16:00:00.000Z");
  });

  it.each([
    ["when plan/lisbon changes", { type: "plan", id: "lisbon" }],
    ["When plan changes.", { type: "plan" }],
    ["when any booking changes", { type: "booking" }],
    ["when a booking changes where status=confirmed", { type: "booking", where: { status: "confirmed" } }],
    [
      "when booking changes where status is confirmed and city = Lisbon",
      { type: "booking", where: { status: "confirmed", city: "Lisbon" } },
    ],
  ])("reads %s as a change", (text, on) => {
    expect(parseEvent(text)).toEqual(on);
    expect(read(text)).toEqual({ kind: "event", on, backstop: new Date(NOW.getTime() + BACKSTOP_MS) });
  });

  it("keeps anything else as a note", () => {
    expect(read("after Sam replies")).toEqual({ kind: "note" });
    expect(read("Friday, to see if prices dropped")).toEqual({ kind: "note" });
    expect(read("when the hotel writes back")).toEqual({ kind: "note" });
  });

  it("won't watch a type the agent it wakes can't read", () => {
    const check = read("when plan/lisbon changes", LISBON, (type) => type !== "plan");
    expect(check).toEqual({ kind: "note", why: "there's no plan record type it can read" });
  });

  it("echoes what it made of each, the way schedule does", () => {
    expect(checkSaid("Friday 9am", read("Friday 9am"), NOW, LISBON)).toBe("Check: Fri, Oct 23, 09:00, in 22h.");
    expect(checkSaid("2026-10-28", read("2026-10-28"), NOW, LISBON)).toBe(
      "Check: Wed, Oct 28, 09:00, in 5d 23h. No time was given, so 09:00.",
    );
    expect(checkSaid("when plan/lisbon changes", read("when plan/lisbon changes"), NOW, LISBON)).toBe(
      "Check: when plan/lisbon changes, or Thu, Oct 29, 10:00 if nothing does by then.",
    );
    expect(checkSaid("2026-10-01", read("2026-10-01"), NOW, LISBON)).toMatch(/which has passed, so it's due now/);
    const note = checkSaid("after Sam replies", read("after Sam replies"), NOW, LISBON);
    expect(note).toContain(`"after Sam replies" isn't a time or a change, so nothing will wake you for it`);
    expect(note).toContain("when plan/lisbon changes");
  });
});

describe("the commitment tool", () => {
  it("keeps a time beside the text and says when it resolved to", async () => {
    const said = await run("planner", {
      action: "open",
      goal: "Watch hotel prices",
      doneWhen: "Three under budget",
      nextCheck: "Friday 9am",
    });
    expect(said).toContain("Check: Fri, Oct 23, 09:00, in 22h.");
    const data = await commitment("planner-watch-hotel-prices");
    expect(data.nextCheck).toBe("Friday 9am");
    expect(data.checkAt).toBe("2026-10-23T08:00:00.000Z");
    expect(data.checkOn).toBeUndefined();
  });

  it("reads the time in the runtime's zone", async () => {
    zone = "America/Los_Angeles";
    await run("planner", { action: "open", goal: "Call the vet", doneWhen: "Booked", nextCheck: "Friday 9am" });
    expect((await commitment("planner-call-the-vet")).checkAt).toBe("2026-10-23T16:00:00.000Z");
  });

  it("turns a change into what it watches, with a backstop a week out", async () => {
    await run("planner", { action: "open", goal: "Watch hotel prices", doneWhen: "Three under budget" });
    const said = await run("planner", {
      action: "update",
      id: "planner-watch-hotel-prices",
      nextCheck: "when plan/lisbon changes",
    });
    expect(said).toContain("Check: when plan/lisbon changes, or Thu, Oct 29, 10:00 if nothing does by then.");
    const data = await commitment("planner-watch-hotel-prices");
    expect(data.checkOn).toEqual({ type: "plan", id: "lisbon" });
    expect(data.checkAt).toBe("2026-10-29T10:00:00.000Z");
  });

  it("keeps text that's neither as a note, says so, and takes away the check it had", async () => {
    await run("planner", {
      action: "open",
      goal: "Watch hotel prices",
      doneWhen: "Three under budget",
      nextCheck: "when plan/lisbon changes",
    });
    const said = await run("planner", {
      action: "update",
      id: "planner-watch-hotel-prices",
      nextCheck: "after Sam replies",
    });
    // Not a refusal: the update went through, and the reply says what will and won't wake it.
    expect(said).toMatch(/^Updated planner-watch-hotel-prices/);
    expect(said).toContain("nothing will wake you for it; it stays a note");
    expect(said).toContain('"Friday 9am"');
    const data = await commitment("planner-watch-hotel-prices");
    expect(data.nextCheck).toBe("after Sam replies");
    expect(data.checkAt).toBeUndefined();
    expect(data.checkOn).toBeUndefined();
  });

  it("won't watch a type the agent can't read", async () => {
    const said = await run("writer", {
      action: "open",
      goal: "Follow the plan",
      doneWhen: "It's settled",
      nextCheck: "when plan/lisbon changes",
    });
    expect(said).toContain("there's no plan record type it can read");
    expect((await commitment("writer-follow-the-plan")).checkOn).toBeUndefined();
  });

  it("reads a room's check as the lead it wakes", async () => {
    // trip-planner leads travel and can't read plans; the planner, a member, writes the check.
    agents["trip-planner"] = {};
    const said = await run("planner", {
      action: "open",
      room: "travel",
      goal: "Book the flights",
      doneWhen: "Tickets in hand",
      nextCheck: "when plan/lisbon changes",
    });
    expect(said).toContain("there's no plan record type it can read");
  });
});

describe("a person's edit", () => {
  async function open(nextCheck?: string) {
    await run("planner", {
      action: "open",
      goal: "Watch hotel prices",
      doneWhen: "Three under budget",
      ...(nextCheck ? { nextCheck } : {}),
    });
    return service.get(PERSON, { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" });
  }

  it("on the State page is read again, as the agent's own would be", async () => {
    const before = await open("Friday 9am");
    await service.patch(
      PERSON,
      { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" },
      { nextCheck: "in 2 days" },
      before?.version,
    );
    await settle();
    expect((await commitment("planner-watch-hotel-prices")).checkAt).toBe("2026-10-24T10:00:00.000Z");

    const now = await service.get(PERSON, { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" });
    await service.patch(
      PERSON,
      { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" },
      { nextCheck: "when plan changes" },
      now?.version,
    );
    await settle();
    const data = await commitment("planner-watch-hotel-prices");
    expect(data.checkOn).toEqual({ type: "plan" });
    expect(data.checkAt).toBe("2026-10-29T10:00:00.000Z");
  });

  it("that clears it, or leaves a note, takes the check away", async () => {
    const before = await open("Friday 9am");
    await service.patch(
      PERSON,
      { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" },
      { nextCheck: null },
      before?.version,
    );
    await settle();
    let data = await commitment("planner-watch-hotel-prices");
    expect(data.checkAt).toBeUndefined();

    const now = await service.get(PERSON, { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" });
    await service.patch(
      PERSON,
      { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" },
      { nextCheck: "when Sam replies" },
      now?.version,
    );
    await settle();
    data = await commitment("planner-watch-hotel-prices");
    expect(data.nextCheck).toBe("when Sam replies");
    expect(data.checkAt).toBeUndefined();
  });

  it("to a note where there was no check writes nothing more", async () => {
    const before = await open();
    await service.patch(
      PERSON,
      { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" },
      { nextCheck: "after Sam replies" },
      before?.version,
    );
    await settle();
    const after = await service.get(PERSON, { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" });
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it("that changes something else leaves the check as the tool read it", async () => {
    const before = await open("Friday 9am");
    await service.patch(
      PERSON,
      { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" },
      { nextStep: "Ask the agent" },
      before?.version,
    );
    await settle();
    const after = await service.get(PERSON, { type: COMMITMENT_TYPE, id: "planner-watch-hotel-prices" });
    expect(after?.data.checkAt).toBe("2026-10-23T08:00:00.000Z");
    // Nothing written after the person's own edit.
    expect(after?.version).toBe((before?.version ?? 0) + 1);
  });

  it("on a room's page is read again too, and the check fields never hold against its members", async () => {
    await run("planner", { action: "open", room: "travel", goal: "Book the flights", doneWhen: "Tickets in hand" });
    const id = "room-travel-book-the-flights";
    const res = await http("PATCH", "rooms/:room/commitments/:id", { room: "travel", id }, { nextCheck: "Friday 9am" });
    expect(res.status).toBe(200);
    await settle();
    let data = await commitment(id);
    expect(data.checkAt).toBe("2026-10-23T08:00:00.000Z");
    expect((data.updates as Array<{ text: string }>)[0].text).toBe('A person set the next check to "Friday 9am".');

    // The person holds the text, so a member can't change it; what the directory keeps beside it doesn't hold.
    const refused = await build("commitment").execute(
      { action: "update", id, nextCheck: "in 2 days" },
      { sessionId: "s", workingDirectory: "/", env: {}, agentName: "planner" },
    );
    expect(refused.success).toBe(false);
    expect(refused.error).toContain("A person set nextCheck");
    expect(refused.error).not.toContain("checkAt");
    await run("planner", { action: "update", id, note: "Found two fares." });
    data = await commitment(id);
    expect(data.checkAt).toBe("2026-10-23T08:00:00.000Z");
  });

  it("to the check fields themselves doesn't hold a room's check against its members", async () => {
    await run("planner", { action: "open", room: "travel", goal: "Book the flights", doneWhen: "Tickets in hand" });
    const id = "room-travel-book-the-flights";
    const before = await service.get(PERSON, { type: COMMITMENT_TYPE, id });
    await service.patch(
      PERSON,
      { type: COMMITMENT_TYPE, id },
      { checkAt: "2026-11-01T09:00:00.000Z" },
      before?.version,
    );
    // The text is what a person holds; the fields beside it follow whoever writes the text next.
    const said = await run("planner", { action: "update", id, nextCheck: "in 2 days" });
    expect(said).toContain("Check: Sat, Oct 24, 11:00, in 2d.");
    expect((await commitment(id)).checkAt).toBe("2026-10-24T10:00:00.000Z");
  });
});
