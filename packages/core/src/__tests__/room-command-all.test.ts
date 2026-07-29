/**
 * `/room all <message>` — say something to every agent in a room.
 *
 * Sits between the two that already existed: `ping` reaches one agent with your
 * words, `status` reaches everyone with a canned question and deliberately puts
 * nothing in the transcript. Neither lets a person say an arbitrary thing to the
 * whole room.
 *
 * The behaviour worth pinning is the addressee list. It is what makes agents on
 * `wakeOn: named`/`addressed` wake at all, and it is what the confirmation
 * message counts — so an agent that cannot hear the message must not appear in
 * either.
 */
import { describe, expect, it, vi } from "vitest";
import type { RoomCommandDeps } from "../channels/discord-room-commands.js";
import { handleRoomCommand, wakeableAgents } from "../channels/discord-room-commands.js";
import type { AgentConfig } from "../config.js";
import type { IdentityResolver } from "../rooms/identities.js";
import type { RoomSubscription } from "../rooms/store.js";
import type { Room } from "../rooms/types.js";

const ROOM: Room = {
  ref: { backend: "discord", id: "123" },
  name: "management",
  purpose: "Management channel.",
} as unknown as Room;

const sub = (agent: string, wakeOn: RoomSubscription["wakeOn"]): RoomSubscription =>
  ({ agent, roomRef: "discord:123", wakeOn, deliver: "push" }) as RoomSubscription;

function makeDeps(subs: RoomSubscription[]) {
  const posted: Array<{ speaker: string; to: string[]; body: string }> = [];
  const identities = {
    get: (name: string) => (subs.some((s) => s.agent === name) ? { kind: "agent", agent: name } : undefined),
    labelForAgent: (a: string) => a,
    byNativeId: () => ({ label: "quinton" }),
    labels: () => subs.map((s) => s.agent),
  } as unknown as IdentityResolver;

  const deps: RoomCommandDeps = {
    store: {
      getRoomByRef: () => ROOM,
      listSubscriptionsForRoom: () => subs,
    } as unknown as RoomCommandDeps["store"],
    identities: () => identities,
    requestStatusUpdate: async () => subs.length,
    resetAgentSession: () => ({ cleared: 0, scope: "room" as const }),
    postAsPerson: async (_room, speaker, to, body) => {
      posted.push({ speaker, to, body });
    },
  };
  return { deps, posted };
}

/**
 * Models discord.js's actual reply state machine, which is the part that
 * mattered: `reply()` THROWS once the interaction is deferred or replied. A
 * double that silently accepts a second reply hides the bug where a failure
 * left the user on a spinner forever.
 */
function makeInteraction(message: string, userId = "1073") {
  const replies: string[] = [];
  const interaction = {
    commandName: "room",
    channelId: "123",
    user: { id: userId, username: "t3hlazy1" },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => "all",
      getString: (name: string) => (name === "message" ? message : null),
    },
    reply: vi.fn(async function (this: typeof interaction, arg: { content: string }) {
      if (interaction.deferred || interaction.replied) {
        throw new Error("InteractionAlreadyReplied");
      }
      interaction.replied = true;
      replies.push(arg.content);
    }),
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async (arg: string | { content: string }) => {
      interaction.replied = true;
      replies.push(typeof arg === "string" ? arg : arg.content);
    }),
    followUp: vi.fn(async (arg: { content: string }) => {
      replies.push(arg.content);
    }),
  };
  return { interaction, replies };
}

const CONFIG = { agents: {} } as unknown as AgentConfig;

describe("/room all", () => {
  it("addresses every agent that can wake, so named/addressed subscribers hear it", async () => {
    const { deps, posted } = makeDeps([sub("manager", "all"), sub("planner", "named"), sub("coder", "addressed")]);
    const { interaction, replies } = makeInteraction("standup in 5");

    // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
    await handleRoomCommand(interaction as any, deps, CONFIG);

    expect(posted).toHaveLength(1);
    expect(posted[0].body).toBe("standup in 5");
    // Without every name here, a `wakeOn: named` agent never wakes — which is
    // the whole difference between this and just typing in the channel.
    expect(posted[0].to.sort()).toEqual(["coder", "manager", "planner"]);
    expect(replies.join(" ")).toContain("3 agent(s)");
  });

  it("posts under the person's identity label, not their Discord username", async () => {
    const { deps, posted } = makeDeps([sub("manager", "all")]);
    const { interaction } = makeInteraction("hello");

    // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
    await handleRoomCommand(interaction as any, deps, CONFIG);

    // `t3hlazy1` in a transcript is how an agent ended up addressing a name no
    // validator had heard of.
    expect(posted[0].speaker).toBe("quinton");
  });

  it("leaves out agents that opted out of waking, and does not count them", async () => {
    const { deps, posted } = makeDeps([sub("manager", "all"), sub("lurker", "none")]);
    const { interaction, replies } = makeInteraction("ping");

    // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
    await handleRoomCommand(interaction as any, deps, CONFIG);

    expect(posted[0].to).toEqual(["manager"]);
    expect(replies.join(" ")).toContain("1 agent(s)");
    expect(replies.join(" ")).not.toContain("lurker");
  });

  it("says nothing was sent when every subscriber is wakeOn:none", async () => {
    const { deps, posted } = makeDeps([sub("lurker", "none")]);
    const { interaction, replies } = makeInteraction("anyone there");

    // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
    await handleRoomCommand(interaction as any, deps, CONFIG);

    expect(posted).toHaveLength(0);
    // Distinguishes "nobody is here" from "everybody is deaf" — they need
    // different fixes, and reporting a silent success would hide both.
    expect(replies.join(" ")).toContain("wakeOn: none");
  });

  it("says so when the room is empty rather than posting into the void", async () => {
    const { deps, posted } = makeDeps([]);
    const { interaction, replies } = makeInteraction("hello");

    // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
    await handleRoomCommand(interaction as any, deps, CONFIG);

    expect(posted).toHaveLength(0);
    expect(replies.join(" ")).toContain("Nobody is subscribed");
  });

  it("refuses an empty message instead of posting a blank line", async () => {
    const { deps, posted } = makeDeps([sub("manager", "all")]);
    const { interaction, replies } = makeInteraction("   ");

    // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
    await handleRoomCommand(interaction as any, deps, CONFIG);

    expect(posted).toHaveLength(0);
    expect(replies.join(" ")).toContain("empty");
  });
});

describe("/room all — failures are reported, not swallowed", () => {
  it("tells the user when the post fails, instead of leaving a spinner forever", async () => {
    const { deps } = makeDeps([sub("manager", "all")]);
    deps.postAsPerson = async () => {
      throw new Error("Unknown Webhook");
    };
    const { interaction, replies } = makeInteraction("standup");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
    await handleRoomCommand(interaction as any, deps, CONFIG);

    // The old code called reply() after deferReply(), which discord.js rejects,
    // and swallowed that rejection — no message, no log, spinner forever.
    expect(replies.join(" ")).toContain("Unknown Webhook");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("/room all — an undeclared speaker is flagged", () => {
  it("warns when the caller has no rooms.identities entry, and names the fix", async () => {
    const { deps, posted } = makeDeps([sub("manager", "all")]);
    // byNativeId misses -> we only know their Discord username.
    (deps.identities() as unknown as { byNativeId: () => undefined }).byNativeId = () => undefined;
    const { interaction, replies } = makeInteraction("standup", "999");

    // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
    await handleRoomCommand(interaction as any, deps, CONFIG);

    expect(posted).toHaveLength(1);
    // Posting still happens — in the webhook path it works. But claiming
    // delivery without saying it may reach nobody is the command lying.
    const said = replies.join(" ");
    expect(said).toContain("rooms.identities");
    expect(said).toContain("999");
  });

  it("stays quiet about identities when the caller is declared", async () => {
    const { deps } = makeDeps([sub("manager", "all")]);
    const { interaction, replies } = makeInteraction("standup");

    // biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
    await handleRoomCommand(interaction as any, deps, CONFIG);

    expect(replies.join(" ")).not.toContain("rooms.identities");
  });
});

describe("wakeableAgents", () => {
  it("filters out wakeOn:none and nothing else", () => {
    const { deps } = makeDeps([sub("a", "all"), sub("b", "named"), sub("c", "addressed"), sub("d", "none")]);

    expect(wakeableAgents(deps, ROOM)).toEqual(["a", "b", "c"]);
  });
});
