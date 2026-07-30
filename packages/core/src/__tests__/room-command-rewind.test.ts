/**
 * `/room rewind` — take an agent's conversation back a few turns.
 *
 * Sits next to `reset`, which throws the whole conversation away. What the
 * reply has to convey is what `reset`'s taught us to say: how far the change
 * reaches (a `shared`-scope agent has one memory across every room, so "this
 * room" would be a quiet lie), and enough of what was dropped to tell a correct
 * cut from an off-by-one.
 */
import { describe, expect, it, vi } from "vitest";
import type { RoomCommandDeps } from "../channels/discord-room-commands.js";
import { handleRoomCommand } from "../channels/discord-room-commands.js";
import type { AgentConfig } from "../config.js";
import type { IdentityResolver } from "../rooms/identities.js";
import type { RoomSubscription } from "../rooms/store.js";
import type { Room } from "../rooms/types.js";

const ROOM: Room = {
  ref: { backend: "discord", id: "123" },
  name: "iris-quinton",
  purpose: "Private 1-on-1.",
} as unknown as Room;

const sub = (agent: string): RoomSubscription =>
  ({ agent, roomRef: "discord:123", wakeOn: "all", deliver: "push" }) as RoomSubscription;

type RewindResult = ReturnType<RoomCommandDeps["rewindAgentSession"]>;

function makeDeps(result: RewindResult, agents = ["iris"]) {
  const calls: Array<{ agent: string; turns: number }> = [];
  const subs = agents.map(sub);
  const deps: RoomCommandDeps = {
    store: {
      getRoomByRef: () => ROOM,
      listSubscriptionsForRoom: () => subs,
    } as unknown as RoomCommandDeps["store"],
    identities: () =>
      ({
        get: () => undefined,
        labelForAgent: (a: string) => a,
        labels: () => agents,
      }) as unknown as IdentityResolver,
    requestStatusUpdate: async () => 0,
    resetAgentSession: () => ({ cleared: 0, scope: "room" as const }),
    rewindAgentSession: async (_room, agent, turns) => {
      calls.push({ agent, turns });
      return result;
    },
    postAsPerson: async () => {},
  };
  return { deps, calls };
}

function makeInteraction(agent: string, turns: number | null) {
  const replies: string[] = [];
  const interaction = {
    commandName: "room",
    channelId: "123",
    user: { id: "1073", username: "t3hlazy1" },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => "rewind",
      getString: (name: string) => (name === "agent" ? agent : null),
      getInteger: (name: string) => (name === "turns" ? turns : null),
    },
    reply: vi.fn(async (arg: { content: string }) => {
      if (interaction.deferred || interaction.replied) throw new Error("InteractionAlreadyReplied");
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
    followUp: vi.fn(async (arg: { content: string }) => replies.push(arg.content)),
  };
  return { interaction, replies };
}

const CONFIG = { agents: {} } as unknown as AgentConfig;
// biome-ignore lint/suspicious/noExplicitAny: hand-built Discord interaction double
const run = (i: unknown, deps: RoomCommandDeps) => handleRoomCommand(i as any, deps, CONFIG);

describe("/room rewind", () => {
  it("defaults to one turn", async () => {
    const { deps, calls } = makeDeps({
      scope: "room",
      rewound: { turns: 1, messages: 2, excerpt: "tell me about X" },
      remaining: 5,
    });
    const { interaction } = makeInteraction("iris", null);

    await run(interaction, deps);

    expect(calls).toEqual([{ agent: "iris", turns: 1 }]);
  });

  it("quotes what it took back and says how to undo it", async () => {
    const { deps } = makeDeps({
      scope: "room",
      rewound: { turns: 2, messages: 5, excerpt: "tell me about X" },
      remaining: 3,
    });
    const { interaction, replies } = makeInteraction("iris", 2);

    await run(interaction, deps);

    const reply = replies.join(" ");
    expect(reply).toContain("2 turn(s)");
    expect(reply).toContain("5 message(s) hidden");
    expect(reply).toContain("3 turn(s) left");
    expect(reply).toContain("tell me about X");
    expect(reply).toContain("turns:0");
    expect(reply).toContain("Nothing was deleted");
  });

  /**
   * The same lie `reset` was fixed to stop telling: an agent on a shared
   * session has one conversation spanning every room it is in.
   */
  it("says when the change reaches beyond this room", async () => {
    const { deps } = makeDeps({
      scope: "shared",
      rewound: { turns: 1, messages: 2, excerpt: "hi" },
      remaining: 4,
    });
    const { interaction, replies } = makeInteraction("iris", 1);

    await run(interaction, deps);

    expect(replies.join(" ")).toContain("every room");
  });

  it("does not claim room-only reach when the memory is per-room", async () => {
    const { deps } = makeDeps({
      scope: "room",
      rewound: { turns: 1, messages: 2, excerpt: "hi" },
      remaining: 4,
    });
    const { interaction, replies } = makeInteraction("iris", 1);

    await run(interaction, deps);

    expect(replies.join(" ")).not.toContain("every room");
  });

  it("restores the last rewind when asked for 0 turns", async () => {
    const { deps, calls } = makeDeps({ scope: "room", restored: 4, remaining: 6 });
    const { interaction, replies } = makeInteraction("iris", 0);

    await run(interaction, deps);

    expect(calls).toEqual([{ agent: "iris", turns: 0 }]);
    expect(replies.join(" ")).toContain("Restored 4 message(s)");
  });

  it("says so when there is no rewind to undo", async () => {
    const { deps } = makeDeps({ scope: "room", restored: 0, remaining: 6 });
    const { interaction, replies } = makeInteraction("iris", 0);

    await run(interaction, deps);

    expect(replies.join(" ")).toContain("no rewind to undo");
  });

  it("says so when there is nothing to take back", async () => {
    const { deps } = makeDeps({ scope: "room", remaining: 0 });
    const { interaction, replies } = makeInteraction("iris", 1);

    await run(interaction, deps);

    expect(replies.join(" ")).toContain("nothing to take back");
  });

  it("refuses an agent that is not in the room, and lists who is", async () => {
    const { deps, calls } = makeDeps({ scope: "room", remaining: 0 }, ["iris"]);
    const { interaction, replies } = makeInteraction("planner", 1);

    await run(interaction, deps);

    expect(calls).toHaveLength(0);
    expect(replies.join(" ")).toContain("not in");
    expect(replies.join(" ")).toContain("iris");
  });
});
