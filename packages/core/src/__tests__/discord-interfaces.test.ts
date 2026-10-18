/**
 * Interface components on Discord: drawn as buttons, a select menu or a pop-up
 * form, and answered by a click.
 *
 * What matters most is the click. It is checked against the stored record —
 * who may answer, whether it is still open, whether the agent can take it now
 * — before anything is recorded, so a refused click leaves the question open.
 * An accepted one is recorded once, the message is rewritten to show the
 * answer, and the conversation carries on with the answer as the person's
 * next message.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newSession } from "../agent/session.js";
import { DiscordChannel } from "../channels/discord.js";
import type { AuthDecision } from "../channels/discord-authorization.js";
import {
  buildAnsweredMessage,
  buildComponentMessage,
  buildFormModal,
  coerceFormValues,
  handleInterfaceInteraction,
  type InterfaceInteractionDeps,
  interfaceCustomId,
  isInterfaceCustomId,
  parseInterfaceCustomId,
} from "../channels/discord-interfaces.js";
import { type ComponentSpec, componentPart, textPart } from "../content/types.js";
import { getSessionMessages } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import { type RuntimeEventPayload, TypedEventBus } from "../events.js";
import { buildComponent, InterfaceError } from "../interfaces/kinds.js";
import { type ComponentRecord, InterfaceStore } from "../interfaces/store.js";
import type { AIProvider } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";

let store: InterfaceStore;
let events: TypedEventBus;

beforeEach(() => {
  store = new InterfaceStore(new Database(":memory:"));
  events = new TypedEventBus();
});

function send(kind: string, props: Record<string, unknown>, extra: Record<string, unknown> = {}): ComponentSpec {
  const spec = buildComponent({ kind, props, ...extra });
  store.create(spec, "planner", "s1");
  return spec;
}

// Builder JSON is loosely typed; the assertions say what shape they expect.
type Json = any;
const rowsOf = (msg: { components: { toJSON(): Json }[] }) =>
  msg.components.map((r) => r.toJSON().components as Json[]);

describe("custom ids", () => {
  it("round-trip the component, the operation and the action", () => {
    const id = interfaceCustomId("c-1a2b3c", "a", "option-2");
    expect(id).toBe("iface:c-1a2b3c:a:option-2");
    expect(isInterfaceCustomId(id)).toBe(true);
    expect(parseInterfaceCustomId(id)).toEqual({ componentId: "c-1a2b3c", op: "a", actionId: "option-2" });
    expect(parseInterfaceCustomId("iface:c-1:m")).toEqual({ componentId: "c-1", op: "m" });
  });

  it("leave other buttons alone", () => {
    expect(isInterfaceCustomId("approve:123")).toBe(false);
    expect(parseInterfaceCustomId("iface:c-1:zz")).toBeNull();
    expect(parseInterfaceCustomId("other:c-1:a")).toBeNull();
  });
});

describe("drawing", () => {
  it("draws a choice as buttons, with 'something else' on its own row", () => {
    const c = send("choice", {
      question: "Which day?",
      options: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
      allowText: true,
    });
    const msg = buildComponentMessage(c);
    expect(msg?.content).toBe("**Which day?**");
    const rows = rowsOf(msg!);
    expect(rows.map((r) => r.length)).toEqual([5, 1, 1]);
    expect(rows[0][1]).toMatchObject({ label: "Tue", custom_id: `iface:${c.id}:a:option-2` });
    expect(rows[2][0]).toMatchObject({ label: "Something else", custom_id: `iface:${c.id}:t` });
  });

  it("falls back to a select menu past twenty options, and to text past twenty-five", () => {
    const actions = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `option-${i + 1}`,
        label: `#${i + 1}`,
        effect: { kind: "reply" as const },
      }));
    const spec = (n: number): ComponentSpec => ({
      id: "c-abcdef",
      kind: "choice",
      props: { question: "Pick" },
      actions: actions(n),
      fallback: "text form",
    });
    const select = rowsOf(buildComponentMessage(spec(21))!)[0][0];
    expect(select).toMatchObject({ custom_id: "iface:c-abcdef:s" });
    expect(select.options).toHaveLength(21);
    expect(buildComponentMessage(spec(26))).toBeNull();
  });

  it("draws a confirm as a green yes and a grey no", () => {
    const c = send("confirm", { summary: "Delete the drafts folder?", details: "12 files" });
    const msg = buildComponentMessage(c)!;
    expect(msg.content).toBe("**Delete the drafts folder?**\n12 files");
    const [yes, no] = rowsOf(msg)[0];
    expect(yes).toMatchObject({ label: "Yes", style: 3, custom_id: `iface:${c.id}:a:confirm` });
    expect(no).toMatchObject({ label: "No", style: 2, custom_id: `iface:${c.id}:a:deny` });
  });

  it("draws a card as an embed with its buttons", () => {
    const c = send(
      "card",
      { title: "Flight", body: "Tomorrow 9:40", fields: [{ label: "Gate", value: "B12" }] },
      { actions: [{ label: "Check in" }, { label: "Snooze", effect: "event", name: "snooze" }] },
    );
    const msg = buildComponentMessage(c)!;
    expect(msg.embeds?.[0].toJSON()).toMatchObject({
      title: "Flight",
      description: "Tomorrow 9:40",
      fields: [{ name: "Gate", value: "B12", inline: true }],
    });
    expect(rowsOf(msg)[0].map((b: Json) => b.label)).toEqual(["Check in", "Snooze"]);
  });

  it("draws a form as one button that opens a pop-up, and gives up past five fields", () => {
    const field = (name: string) => ({ name, label: name });
    const c = send("form", { title: "Dinner", fields: [field("time"), field("guests")] });
    const msg = buildComponentMessage(c)!;
    expect(rowsOf(msg)[0][0]).toMatchObject({ label: "Fill in", custom_id: `iface:${c.id}:f` });

    const long = send("form", { title: "Long", fields: ["a", "b", "c", "d", "e", "f"].map(field) });
    expect(buildComponentMessage(long)).toBeNull();
  });

  it("returns null for a kind it has no drawing for, or an id a custom id cannot carry", () => {
    const base = { kind: "choice", props: { question: "q" }, actions: [], fallback: "f" };
    expect(buildComponentMessage({ ...base, id: "c-1", kind: "map" })).toBeNull();
    expect(buildComponentMessage({ ...base, id: "has:colon" })).toBeNull();
  });

  it("shows an answered component with every control disabled and the choice marked", () => {
    const c = send("choice", { question: "Which day?", options: ["Mon", "Tue"] });
    const msg = buildAnsweredMessage(c, { actionId: "option-2", label: "Tue — <@u1>" })!;
    expect(msg.content).toBe("**Which day?**\n✅ Tue — <@u1>");
    const [mon, tue] = rowsOf(msg)[0];
    expect(mon).toMatchObject({ disabled: true, style: 2 });
    expect(tue).toMatchObject({ disabled: true, style: 3 });
  });

  it("builds a pop-up with one input per field and a hint for typed ones", () => {
    const c = send("form", {
      title: "Dinner",
      fields: [
        { name: "guests", label: "Guests", type: "number", required: true },
        { name: "where", label: "Where", type: "select", options: ["Home", "Out"] },
      ],
    });
    const modal = buildFormModal(c).toJSON() as Json;
    expect(modal).toMatchObject({ custom_id: `iface:${c.id}:m`, title: "Dinner" });
    const inputs = modal.components.map((r: Json) => r.components[0]);
    expect(inputs[0]).toMatchObject({ custom_id: "guests", label: "Guests", required: true, placeholder: "A number" });
    expect(inputs[1]).toMatchObject({ custom_id: "where", required: false, placeholder: "One of: Home, Out" });
  });
});

describe("coerceFormValues", () => {
  const form = buildComponent({
    kind: "form",
    props: {
      title: "Trip",
      fields: [
        { name: "nights", label: "Nights", type: "number" },
        { name: "pets", label: "Pets", type: "boolean" },
        { name: "room", label: "Room", type: "select", options: ["Single", "Double"] },
        { name: "note", label: "Note" },
      ],
    },
  });

  it("types what a pop-up can only send as text", () => {
    expect(coerceFormValues(form, { nights: " 3 ", pets: "Yes", room: "double", note: "late check-in" })).toEqual({
      nights: 3,
      pets: true,
      room: "Double",
      note: "late check-in",
    });
  });

  it("skips blanks, and refuses what does not fit with a reason", () => {
    expect(coerceFormValues(form, { nights: "", pets: "no" })).toEqual({ pets: false });
    expect(() => coerceFormValues(form, { nights: "three" })).toThrow("Nights must be a number.");
    expect(() => coerceFormValues(form, { pets: "maybe" })).toThrow("Pets: answer yes or no.");
    expect(() => coerceFormValues(form, { room: "suite" })).toThrow(InterfaceError);
  });
});

interface FakeInteraction {
  customId: string;
  user: { id: string };
  channelId: string;
  guildId: string | null;
  values?: string[];
  fields?: { getTextInputValue(name: string): string };
  kind: "button" | "select" | "modal";
  replies: { content: string }[];
  updates: Json[];
  modals: Json[];
}

function interaction(customId: string, over: Partial<FakeInteraction> = {}): FakeInteraction & Record<string, unknown> {
  const i = {
    customId,
    user: { id: "u1" },
    channelId: "chan1",
    guildId: "g1",
    kind: "button" as const,
    replies: [],
    updates: [],
    modals: [],
    ...over,
  };
  return Object.assign(i, {
    isButton: () => i.kind === "button",
    isStringSelectMenu: () => i.kind === "select",
    isModalSubmit: () => i.kind === "modal",
    isFromMessage: () => true,
    reply: async (r: { content: string }) => void i.replies.push(r),
    update: async (u: Json) => void i.updates.push(u),
    showModal: async (m: { toJSON(): Json }) => void i.modals.push(m.toJSON()),
  });
}

function deps(over: Partial<InterfaceInteractionDeps> = {}) {
  const continued: { reply: string; where: { channelId: string; userId: string } }[] = [];
  const d: InterfaceInteractionDeps = {
    store,
    events,
    authorize: () => ({ ok: true }),
    continueWith: async (_record, reply, where) => void continued.push({ reply, where }),
    ...over,
  };
  return { d, continued };
}

const handle = (i: ReturnType<typeof interaction>, d: InterfaceInteractionDeps) =>
  handleInterfaceInteraction(i as never, d);

describe("handleInterfaceInteraction", () => {
  it("records a click once, rewrites the message, and carries the answer on", async () => {
    const c = send("choice", { question: "Which day?", options: ["Mon", "Tue"] });
    const { d, continued } = deps();
    const click = interaction(`iface:${c.id}:a:option-2`);
    await handle(click, d);

    expect(store.get(c.id)).toMatchObject({ status: "answered", response: { actionId: "option-2", by: "discord:u1" } });
    expect(click.updates[0].content).toBe("**Which day?**\n✅ Tue — <@u1>");
    expect(continued).toEqual([{ reply: "Tue", where: { channelId: "chan1", userId: "u1" } }]);

    const late = interaction(`iface:${c.id}:a:option-1`, { user: { id: "u1" } });
    await handle(late, d);
    expect(late.replies[0].content).toBe("This has already been answered.");
    expect(continued).toHaveLength(1);
  });

  it("refuses someone who may not answer, and leaves the question open", async () => {
    const c = send("confirm", { summary: "Send it?" });
    const authorize = vi.fn(() => ({ ok: false, reason: "This question was asked of someone else." }));
    const { d, continued } = deps({ authorize });
    const click = interaction(`iface:${c.id}:a:confirm`, { user: { id: "u2" } });
    await handle(click, d);

    expect(authorize).toHaveBeenCalledWith(click, expect.objectContaining({ agent: "planner", sessionId: "s1" }));
    expect(click.replies[0].content).toBe("This question was asked of someone else.");
    expect(store.get(c.id)?.status).toBe("open");
    expect(continued).toEqual([]);
  });

  it("refuses while the agent is busy, so the person can try again", async () => {
    const c = send("confirm", { summary: "Send it?" });
    const { d, continued } = deps({ unavailable: () => "I'm still working on your previous message." });
    const click = interaction(`iface:${c.id}:a:confirm`);
    await handle(click, d);

    expect(click.replies[0].content).toBe("I'm still working on your previous message.");
    expect(store.get(c.id)?.status).toBe("open");
    expect(continued).toEqual([]);
  });

  it("says so when the component is gone", async () => {
    const { d } = deps();
    const click = interaction("iface:c-000000:a:confirm");
    await handle(click, d);
    expect(click.replies[0].content).toBe("This question is no longer available.");
  });

  it("opens the pop-up without answering, then types and records what comes back", async () => {
    const c = send("form", {
      title: "Dinner",
      fields: [
        { name: "guests", label: "Guests", type: "number", required: true },
        { name: "note", label: "Note" },
      ],
    });
    const { d, continued } = deps();
    const open = interaction(`iface:${c.id}:f`);
    await handle(open, d);
    expect(open.modals[0]).toMatchObject({ custom_id: `iface:${c.id}:m` });
    expect(store.get(c.id)?.status).toBe("open");

    const values = (v: Record<string, string>) => ({
      getTextInputValue: (name: string) => {
        if (!(name in v)) throw new Error("no such field");
        return v[name];
      },
    });
    const wrong = interaction(`iface:${c.id}:m`, { kind: "modal", fields: values({ guests: "four" }) });
    await handle(wrong, d);
    expect(wrong.replies[0].content).toBe("Guests must be a number.");
    expect(store.get(c.id)?.status).toBe("open");

    const right = interaction(`iface:${c.id}:m`, { kind: "modal", fields: values({ guests: "4", note: "" }) });
    await handle(right, d);
    expect(store.get(c.id)?.response?.value).toEqual({ guests: 4 });
    expect(right.updates[0].content).toBe("**Dinner**\n✅ Sent — <@u1>");
    expect(continued[0].reply).toBe("Dinner\nGuests: 4");
  });

  it("takes a free-text answer from the 'something else' pop-up", async () => {
    const c = send("choice", { question: "Where?", options: ["Home", "Office"], allowText: true });
    const { d, continued } = deps();
    const open = interaction(`iface:${c.id}:t`);
    await handle(open, d);
    expect(open.modals[0]).toMatchObject({ custom_id: `iface:${c.id}:mt` });

    const submit = interaction(`iface:${c.id}:mt`, {
      kind: "modal",
      fields: { getTextInputValue: () => "  the library  " },
    });
    await handle(submit, d);
    expect(continued[0].reply).toBe("the library");
    expect(submit.updates[0].content).toBe("**Where?**\n✅ the library — <@u1>");
  });

  it("announces an event action instead of continuing the conversation", async () => {
    const c = send("card", { title: "Flight" }, { actions: [{ label: "Snooze", effect: "event", name: "snooze" }] });
    const announced: RuntimeEventPayload<"interface.action">[] = [];
    events.on("interface.action", (p) => {
      announced.push(p);
    });
    const { d, continued } = deps();
    await handle(interaction(`iface:${c.id}:a:a1`), d);
    expect(announced).toMatchObject([{ componentId: c.id, name: "snooze", by: "discord:u1" }]);
    expect(continued).toEqual([]);
  });
});

describe("DiscordChannel", () => {
  let db: Database.Database;
  let reply: string;

  beforeEach(() => {
    db = initDatabase(":memory:");
    reply = "Booked for Tue.";
  });

  const fakeProvider: AIProvider = {
    name: "fake",
    chat: async () => ({ content: reply, usage: { input: 1, output: 1 }, finishReason: "stop" }),
  } as never;

  function makeChannel(discord: Record<string, unknown> = {}) {
    const config = {
      server: { port: 3000, host: "127.0.0.1" },
      database: { path: ":memory:" },
      providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
      agent: {
        defaultProvider: "openai_compatible",
        maxToolRounds: 1,
        maxHistoryTokens: 2000,
        temperature: 0.3,
        extraInstructions: "",
      },
      agents: {},
      channels: { discord: { enabled: false, token: "x", ...discord } },
      tools: {},
      custom_tools: {},
      cron: { enabled: false, jobs: [] },
      context: { directory: "./data/context", kbDirectory: "./data/kb" },
      prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
      permissions: { allow: [], deny: [], ask: [] },
      workflows: { directory: "./workflows" },
      projects: { enabled: false, directory: "./data/projects" },
      tasks: { backend: "native" as const },
    } as never;
    const runtime = new AgentRuntime(
      {
        configPath: "/dev/null",
        db,
        contextDir: "/tmp",
        kbDir: "/tmp",
        createTools: () => [],
        createProvider: () => ({ provider: fakeProvider, model: "x" }),
      },
      () => config,
      config,
    );
    const channel = new DiscordChannel({ runtime });
    const sent: Json[] = [];
    const discordChannel = {
      isTextBased: () => true,
      send: async (p: Json) => void sent.push(p),
      sendTyping: async () => {},
    };
    (channel as unknown as { client: { channels: { fetch: unknown } } }).client.channels.fetch = async () =>
      discordChannel;
    return { channel, runtime, sent, priv: channel as unknown as Private };
  }

  interface Private {
    deliver(content: unknown, post: (payload: Json, first: boolean) => Promise<unknown>): Promise<void>;
    authorizeAnswer(record: ComponentRecord, userId: string, guildId: string | undefined): AuthDecision;
    continueInterface(
      record: ComponentRecord,
      reply: string,
      where: { channelId: string; userId: string },
    ): Promise<void>;
    processing: Set<string>;
  }

  function record(sessionKey: string | null): ComponentRecord {
    const session = newSession(db, "x", "openai_compatible", sessionKey ?? undefined);
    const spec = buildComponent({ kind: "choice", props: { question: "Which day?", options: ["Mon", "Tue"] } });
    const s = new InterfaceStore(db);
    s.create(spec, "default", session.id);
    return s.get(spec.id)!;
  }

  it("posts the reply, then each component as its own message, and text for one it cannot draw", async () => {
    const { priv } = makeChannel();
    const choice = buildComponent({ kind: "choice", props: { question: "Which day?", options: ["Mon", "Tue"] } });
    const long = buildComponent({
      kind: "form",
      props: { title: "Long", fields: ["a", "b", "c", "d", "e", "f"].map((name) => ({ name })) },
    });
    const posts: { payload: Json; first: boolean }[] = [];
    await priv.deliver(
      { parts: [textPart("Here:"), componentPart(choice), componentPart(long)] },
      async (payload, first) => posts.push({ payload, first }),
    );
    expect(posts.map((p) => p.first)).toEqual([true, false, false]);
    expect(posts[0].payload).toEqual({ content: "Here:" });
    expect(posts[1].payload.content).toBe("**Which day?**");
    expect(posts[1].payload.components).toHaveLength(1);
    expect(posts[2].payload).toEqual({ content: long.fallback });
  });

  it("lets only the person a Discord conversation belongs to answer in it", () => {
    const { priv } = makeChannel({ owner: "u9" });
    const r = record("discord:u1");
    expect(priv.authorizeAnswer(r, "u1", "g1")).toEqual({ ok: true });
    expect(priv.authorizeAnswer(r, "u9", "g1")).toEqual({
      ok: false,
      reason: "This question was asked of someone else.",
    });
  });

  it("leaves a conversation nobody on Discord owns to the deployment owner, except in a DM", () => {
    const r = record("subscriptions:planner");
    const unset = makeChannel().priv.authorizeAnswer(r, "u1", "g1");
    expect(unset.ok).toBe(false);
    expect(!unset.ok && unset.reason).toContain("`channels.discord.owner` is not set");

    const { priv } = makeChannel({ owner: "u9" });
    expect(priv.authorizeAnswer(r, "u9", "g1")).toEqual({ ok: true });
    expect(priv.authorizeAnswer(r, "u1", "g1")).toEqual({
      ok: false,
      reason: "Only the deployment owner can answer this.",
    });
    expect(priv.authorizeAnswer(r, "u1", undefined)).toEqual({ ok: true });
  });

  it("honours the server allowlist", () => {
    const { priv } = makeChannel({ allowedGuilds: ["g2"] });
    expect(priv.authorizeAnswer(record("discord:u1"), "u1", "g1").ok).toBe(false);
  });

  it("carries the answer on as the person's next message and posts what the agent says", async () => {
    const { priv, sent } = makeChannel();
    const r = record("discord:u1");
    await priv.continueInterface(r, "Tue", { channelId: "chan1", userId: "u1" });

    expect(sent).toEqual([{ content: "Booked for Tue." }]);
    const messages = getSessionMessages(db, r.sessionId).map((m) => [m.role, m.content]);
    expect(messages).toEqual([
      ["user", "Tue"],
      ["assistant", "Booked for Tue."],
    ]);
    expect(priv.processing.size).toBe(0);
  });

  it("does not start a second turn in a conversation that is already running one", async () => {
    const { priv, sent } = makeChannel();
    const r = record("discord:u1");
    priv.processing.add("discord:u1");
    await priv.continueInterface(r, "Tue", { channelId: "chan1", userId: "u1" });
    expect(sent[0].content).toContain("Send it again as a message.");
    expect(getSessionMessages(db, r.sessionId)).toEqual([]);
  });
});
