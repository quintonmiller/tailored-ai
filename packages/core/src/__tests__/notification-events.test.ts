/**
 * The notification gate says what it sends, and lets a subscriber hold one back.
 *
 * `notification.outgoing` runs before the repeat check, so a plugin sees every
 * message nobody asked for and can stop one; `notification.sent` follows a send
 * that went out, and nothing else. Every sender names what kind of message it
 * is, coarse enough to mute or count. Without a bus the gate is what it always
 * was.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEventHookHandler } from "../agent/event-hooks.js";
import type { OutboundNotifier } from "../channels/outbound.js";
import type { AgentConfig, CronJobConfig } from "../config.js";
import { CronScheduler } from "../cron/scheduler.js";
import { initDatabase } from "../db/schema.js";
import { type EventBus, type NotificationOutgoingWaterfall, type NotificationSent, TypedEventBus } from "../events.js";
import {
  type NotificationCandidate,
  NotificationGate,
  type NotificationGateLike,
  notificationKind,
} from "../notifications/dedup.js";
import { ConfigHooks } from "../plugins/config-hooks.js";
import { OwnerNotifier } from "../plugins/owner-notifier.js";
import type { AgentRuntime } from "../runtime.js";
import type { ToolContext } from "../tools/interface.js";
import { NotifyOwnerTool } from "../tools/notify-owner.js";

let db: Database.Database;

const candidate = (content: string, over: Partial<NotificationCandidate> = {}): NotificationCandidate => ({
  source: "cron:digest",
  channel: "discord",
  target: "OWNER",
  content,
  ...over,
});

/** Everything `notification.sent` carried. */
function sentOn(events: EventBus): NotificationSent[] {
  const sent: NotificationSent[] = [];
  events.on("notification.sent", (p) => {
    sent.push(p);
  });
  return sent;
}

const rows = () => (db.prepare("SELECT COUNT(*) AS c FROM notification_log").get() as { c: number }).c;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("notification.outgoing", () => {
  it("holds a message back when a subscriber denies it, and logs the reason the way a repeat is logged", async () => {
    const events = new TypedEventBus();
    events.onWaterfall("notification.outgoing", async (p, next) =>
      p.kind === "cron:digest" ? { ...p, deny: "the owner muted this kind" } : next(p),
    );
    const sent = sentOn(events);
    const gate = new NotificationGate(db, () => undefined, events);
    const send = vi.fn(async () => {});
    const lines: string[] = [];

    const decision = await gate.deliver(candidate("Morning digest: 3 new items"), send, (l) => lines.push(l));

    expect(send).not.toHaveBeenCalled();
    expect(decision).toEqual({ send: false, verdict: "held", reason: "the owner muted this kind", suppressedCount: 0 });
    expect(lines).toEqual(["[notify] suppressed cron:digest -> OWNER (the owner muted this kind)"]);
    expect(sent).toEqual([]);
    // Nothing went out, so nothing is counted as sent or as a repeat withheld.
    expect(rows()).toBe(0);
  });

  it("lets a kind nobody muted through", async () => {
    const events = new TypedEventBus();
    events.onWaterfall("notification.outgoing", async (p, next) =>
      p.kind === "cron:weather" ? { ...p, deny: "muted" } : next(p),
    );
    const gate = new NotificationGate(db, () => undefined, events);
    const send = vi.fn(async () => {});

    const decision = await gate.deliver(candidate("Morning digest"), send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(decision.verdict).toBe("new");
  });

  it("sees every message before the repeat check, repeats included, with what the gate knows about it", async () => {
    const events = new TypedEventBus();
    const seen: NotificationOutgoingWaterfall[] = [];
    events.onWaterfall("notification.outgoing", async (p, next) => {
      seen.push(p);
      return next(p);
    });
    const gate = new NotificationGate(db, () => undefined, events);
    const long = `The nightly build is red. ${"x".repeat(300)}`;
    const send = vi.fn(async () => {});

    await gate.deliver(candidate(long, { source: "room:planner", kind: "room", agent: "planner" }), send);
    const repeat = await gate.deliver(
      candidate(long, { source: "room:planner", kind: "room", agent: "planner" }),
      send,
    );

    expect(repeat.verdict).toBe("repeat-exact");
    expect(send).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({
      source: "room:planner",
      kind: "room",
      agent: "planner",
      channel: "discord",
      target: "OWNER",
      preview: long.slice(0, 200),
    });
  });

  it("still sends when a subscriber throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const events = new TypedEventBus();
    events.onWaterfall("notification.outgoing", async () => {
      throw new Error("plugin broke");
    });
    const gate = new NotificationGate(db, () => undefined, events);
    const send = vi.fn(async () => {});

    const decision = await gate.deliver(candidate("The nightly build is red."), send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(decision.send).toBe(true);
  });

  it("still sends when the bus itself throws", async () => {
    const events = new TypedEventBus();
    vi.spyOn(events, "waterfall").mockRejectedValue(new Error("bus down"));
    const gate = new NotificationGate(db, () => undefined, events);
    const send = vi.fn(async () => {});
    const lines: string[] = [];

    const decision = await gate.deliver(candidate("The nightly build is red."), send, (l) => lines.push(l));

    expect(send).toHaveBeenCalledTimes(1);
    expect(decision.send).toBe(true);
    expect(lines[0]).toContain("notification.outgoing failed (bus down)");
  });

  it("does not run again for a message a subscriber sends while it runs", async () => {
    // A subscriber that copies every message somewhere through the same gate.
    // The repeat check comes after the waterfall, so it can't end the loop;
    // without a guard each copy runs the waterfall again before anything is
    // sent. Capped here so a broken guard fails the test instead of hanging it.
    const events = new TypedEventBus();
    const sent = sentOn(events);
    const gate = new NotificationGate(db, () => undefined, events);
    const send = vi.fn(async () => {});
    let runs = 0;
    events.onWaterfall("notification.outgoing", async (p, next) => {
      runs += 1;
      if (runs < 5) await gate.deliver(candidate(`audit: ${p.preview}`, { source: "audit", target: "AUDIT" }), send);
      return next(p);
    });

    const decision = await gate.deliver(candidate("The nightly build is red."), send);

    expect(runs).toBe(1);
    expect(decision.send).toBe(true);
    // The copy still goes through the repeat check and is announced.
    expect(send).toHaveBeenCalledTimes(2);
    expect(sent.map((s) => s.source)).toEqual(["audit", "cron:digest"]);
  });

  it("runs again for the next message once a subscriber has finished", async () => {
    // The guard is scoped to the subscriber's own work, not left set behind it.
    const events = new TypedEventBus();
    const gate = new NotificationGate(db, () => undefined, events);
    let runs = 0;
    events.onWaterfall("notification.outgoing", async (p, next) => {
      runs += 1;
      return next(p);
    });

    await gate.deliver(candidate("The nightly build is red."), async () => {});
    await gate.deliver(candidate("The nightly build is green again."), async () => {});

    expect(runs).toBe(2);
  });
});

describe("notification.sent", () => {
  it("follows a send that went out, with the log row it was recorded on", async () => {
    const events = new TypedEventBus();
    const sent = sentOn(events);
    const gate = new NotificationGate(db, () => undefined, events);
    let sentBeforeSend = -1;

    await gate.deliver(candidate("The nightly build is red.", { kind: "cron:build", agent: "planner" }), async () => {
      sentBeforeSend = sent.length;
    });

    expect(sentBeforeSend).toBe(0);
    const row = db.prepare("SELECT id, last_sent_at FROM notification_log").get() as {
      id: number;
      last_sent_at: string;
    };
    expect(sent).toEqual([
      {
        source: "cron:digest",
        kind: "cron:build",
        agent: "planner",
        channel: "discord",
        target: "OWNER",
        preview: "The nightly build is red.",
        logId: row.id,
        at: row.last_sent_at,
      },
    ]);
  });

  it("is not said for a repeat the gate withheld", async () => {
    const events = new TypedEventBus();
    const sent = sentOn(events);
    const gate = new NotificationGate(db, () => undefined, events);
    const send = vi.fn(async () => {});

    await gate.deliver(candidate("The nightly build is red."), send);
    await gate.deliver(candidate("The nightly build is red."), send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("is not said for a send that threw", async () => {
    const events = new TypedEventBus();
    const sent = sentOn(events);
    const gate = new NotificationGate(db, () => undefined, events);

    await expect(
      gate.deliver(candidate("The nightly build is red."), async () => {
        throw new Error("discord down");
      }),
    ).rejects.toThrow("discord down");

    expect(sent).toEqual([]);
  });

  it("is still said, without a log id, when the log can't be read or written", async () => {
    const events = new TypedEventBus();
    const sent = sentOn(events);
    const gate = new NotificationGate(db, () => undefined, events);
    db.exec("DROP TABLE notification_log");
    const send = vi.fn(async () => {});

    const decision = await gate.deliver(candidate("The nightly build is red."), send, () => {});

    expect(send).toHaveBeenCalledTimes(1);
    expect(decision.send).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].logId).toBeUndefined();
    expect(sent[0].at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  it("does not turn a delivered message into a failure when the bus throws", async () => {
    const events = new TypedEventBus();
    vi.spyOn(events, "emit").mockImplementation(() => {
      throw new Error("bus down");
    });
    const gate = new NotificationGate(db, () => undefined, events);
    const send = vi.fn(async () => {});

    const decision = await gate.deliver(candidate("The nightly build is red."), send, () => {});

    expect(send).toHaveBeenCalledTimes(1);
    expect(decision.send).toBe(true);
  });
});

describe("with no bus", () => {
  it("delivers, records and withholds repeats as it always has", async () => {
    const gate = new NotificationGate(db, () => undefined);
    const send = vi.fn(async () => {});

    const first = await gate.deliver(candidate("The nightly build is red."), send);
    const second = await gate.deliver(candidate("The nightly build is red."), send);

    expect(first).toEqual({ send: true, verdict: "new", suppressedCount: 0 });
    expect(second.verdict).toBe("repeat-exact");
    expect(send).toHaveBeenCalledTimes(1);
    expect(rows()).toBe(1);
  });
});

describe("notificationKind", () => {
  it("is the caller's when it names one", () => {
    expect(notificationKind({ source: "cron:digest", kind: "digest" })).toBe("digest");
  });

  it("is the source with the sending agent's name taken off the end", () => {
    expect(notificationKind({ source: "room:planner", agent: "planner" })).toBe("room");
    expect(notificationKind({ source: "tool:notify_owner:planner", agent: "planner" })).toBe("tool:notify_owner");
  });

  it("is the source as it stands when no agent is named, or the source doesn't end in it", () => {
    expect(notificationKind({ source: "room:planner" })).toBe("room:planner");
    expect(notificationKind({ source: "cron:digest", agent: "planner" })).toBe("cron:digest");
    // A name that only ends the same way is not the agent's.
    expect(notificationKind({ source: "room:trip-planner", agent: "planner" })).toBe("room:trip-planner");
  });
});

/** A gate that sends everything and remembers what it was asked to send. */
function recordingGate(): NotificationGateLike & { seen: NotificationCandidate[] } {
  const seen: NotificationCandidate[] = [];
  return {
    seen,
    async deliver(c, send) {
      seen.push(c);
      await send();
      return { send: true, verdict: "new", suppressedCount: 0 };
    },
  };
}

function outbound(): OutboundNotifier & { sendDM: ReturnType<typeof vi.fn> } {
  return { id: "discord", send: vi.fn(async () => undefined), sendDM: vi.fn(async () => undefined) };
}

describe("every sender names its kind", () => {
  async function settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it("the owner notifier: task-blocked, digest and question", async () => {
    const events = new TypedEventBus();
    const gate = recordingGate();
    const runtime = {
      db,
      events,
      resolveOutbound: () => outbound(),
      getOwnerId: () => "OWNER",
      getConfig: () => ({}),
      getNotificationGate: () => gate,
    } as unknown as AgentRuntime;
    const notifier = new OwnerNotifier({ runtime });

    events.emit("task.needs_human", { taskId: "ptask_1", agentName: "planner", reason: "error", message: "stuck" });
    events.emit("digest.ready", { content: "daily summary", periodLabel: "Morning" });
    events.emit("question.asked", { question: "What's the budget?", taskId: "ptask_9" });
    events.emit("question.asked", { question: "Which hotel?" });
    await settle();

    expect(gate.seen.map((c) => [c.kind, c.agent])).toEqual([
      ["task-blocked", "planner"],
      ["digest", undefined],
      ["question", undefined],
      ["question", undefined],
    ]);
    notifier.stop();
  });

  it("a cron job: cron:<job>, from the agent that ran it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gate = recordingGate();
    const sink = outbound();
    const runtime = {
      getConfig: () => ({ channels: { discord: { owner: "OWNER" } } }),
      getOutbound: () => sink,
      getOwnerId: () => "OWNER",
      getNotificationGate: () => gate,
    } as unknown as AgentRuntime;
    const scheduler = new CronScheduler({ runtime });
    const deliver = (job: CronJobConfig, response: string) =>
      (scheduler as unknown as { deliver(j: CronJobConfig, r: string): Promise<void> }).deliver(job, response);

    await deliver(
      {
        name: "weather",
        schedule: "0 7 * * *",
        prompt: "p",
        agent: "planner",
        delivery: { channel: "discord", mode: "dm" },
      },
      "Rain at noon.",
    );
    await deliver(
      { name: "standup", schedule: "0 9 * * *", prompt: "p", delivery: { channel: "discord", target: "room-1" } },
      "Standup notes.",
    );

    expect(gate.seen.map((c) => [c.source, c.kind, c.agent])).toEqual([
      ["cron:weather", "cron:weather", "planner"],
      ["cron:standup", "cron:standup", undefined],
    ]);
  });

  it("notify_owner: notify:<what woke it> in a woken turn, notify in a background tick", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const gate = recordingGate();
    const sink = outbound();
    const tool = new NotifyOwnerTool(
      () => sink,
      () => "OWNER",
      () => gate,
    );
    const ctx = (over: Partial<ToolContext>): ToolContext => ({
      sessionId: "s",
      workingDirectory: "/tmp",
      env: {},
      agentName: "planner",
      ...over,
    });

    await tool.execute({ message: "Your plan changed." }, ctx({ wake: { kind: "upkeep", ref: "plan/trip" } }));
    await tool.execute({ message: "The build is red." }, ctx({ exploratoryRunId: "run-1" }));
    await tool.execute({ message: "Task done." }, ctx({ autopilotTaskId: "ptask_1" }));

    expect(gate.seen.map((c) => [c.kind, c.agent])).toEqual([
      ["notify:upkeep", "planner"],
      ["notify", "planner"],
      ["notify", "planner"],
    ]);
  });
});

describe("notify_owner held back by a subscriber", () => {
  it("tells the agent why, and sends nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const events = new TypedEventBus();
    events.onWaterfall("notification.outgoing", async (p) => ({
      ...p,
      deny: "The owner muted upkeep nudges. Put it on your page instead.",
    }));
    const gate = new NotificationGate(db, () => undefined, events);
    const sink = outbound();
    const tool = new NotifyOwnerTool(
      () => sink,
      () => "OWNER",
      () => gate,
    );

    const result = await tool.execute(
      { message: "Your plan changed." },
      { sessionId: "s", workingDirectory: "/tmp", env: {}, agentName: "planner", wake: { kind: "upkeep" } },
    );

    expect(sink.sendDM).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      output: "Not sent — The owner muted upkeep nudges. Put it on your page instead.",
    });
  });
});

describe("config hooks", () => {
  function config(on: Record<string, unknown>): AgentConfig {
    return {
      agent: { defaultProvider: "openai_compatible", extraInstructions: "" },
      agents: {},
      hooks: { on },
    } as unknown as AgentConfig;
  }
  function runtimeFor(cfg: AgentConfig, events: TypedEventBus): AgentRuntime {
    return {
      events,
      getConfig: () => cfg,
      getTools: () => [],
      agentToolContext: () => ({}),
    } as unknown as AgentRuntime;
  }

  it("a hook on notification.outgoing that refuses holds the message back", async () => {
    const dispose = registerEventHookHandler("mute-test", async (ctx) =>
      ctx.payload.kind === "cron:weather" ? { deny: "weather is muted" } : { output: "" },
    );
    const events = new TypedEventBus();
    const hooks = new ConfigHooks({
      runtime: runtimeFor(config({ "notification.outgoing": { type: "mute-test" } }), events),
    });
    const gate = new NotificationGate(db, () => undefined, events);
    const send = vi.fn(async () => {});

    const weather = await gate.deliver(candidate("Rain at noon.", { source: "cron:weather" }), send);
    const digest = await gate.deliver(candidate("Morning digest."), send);

    expect(weather).toMatchObject({ send: false, verdict: "held", reason: "weather is muted" });
    expect(digest.send).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    hooks.stop();
    dispose();
  });

  it("a hook on notification.outgoing that sends a message itself does not loop", async () => {
    // The shape of a hook that copies every unprompted message to an audit
    // room: its handler sends through the same gate while the waterfall runs.
    const events = new TypedEventBus();
    const gate = new NotificationGate(db, () => undefined, events);
    const send = vi.fn(async () => {});
    let runs = 0;
    const dispose = registerEventHookHandler("copy-test", async (ctx) => {
      runs += 1;
      if (runs < 5) {
        await gate.deliver(
          candidate(`copy: ${String(ctx.payload.preview)}`, { source: "copy", target: "AUDIT" }),
          send,
        );
      }
      return { output: "" };
    });
    const hooks = new ConfigHooks({
      runtime: runtimeFor(config({ "notification.outgoing": { type: "copy-test" } }), events),
    });

    const decision = await gate.deliver(candidate("Rain at noon.", { source: "cron:weather" }), send);

    expect(runs).toBe(1);
    expect(decision.send).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    hooks.stop();
    dispose();
  });

  it("a hook on notification.sent sees every message that went out", async () => {
    const seen: Record<string, unknown>[] = [];
    const dispose = registerEventHookHandler("log-test", async (ctx) => {
      seen.push(ctx.payload);
      return { output: "" };
    });
    const events = new TypedEventBus();
    const hooks = new ConfigHooks({
      runtime: runtimeFor(config({ "notification.sent": { type: "log-test" } }), events),
    });
    const gate = new NotificationGate(db, () => undefined, events);

    await gate.deliver(candidate("Morning digest.", { kind: "digest" }), async () => {});
    await gate.deliver(candidate("Morning digest.", { kind: "digest" }), async () => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "digest", preview: "Morning digest.", target: "OWNER" });
    hooks.stop();
    dispose();
  });
});
