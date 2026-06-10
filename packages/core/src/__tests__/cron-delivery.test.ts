/**
 * Cron delivery-resolution tests (#142). Exercise CronScheduler's `deliver`
 * over the open `{ channel, mode, target }` delivery shape: the "log"
 * console sentinel, channel-post (`send`), direct-message (`sendDM`) with an
 * explicit target and with the channel-owner fallback, and an unregistered
 * channel (logs an error, does not throw). Uses a stub runtime with a fake
 * outbound registry, mirroring discord-notifier.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJobConfig } from "../config.js";
import { CronScheduler } from "../cron/scheduler.js";
import type { AgentRuntime } from "../runtime.js";

function makeRuntime(outbound?: {
  send: (...a: unknown[]) => unknown;
  sendDM: (...a: unknown[]) => unknown;
}): AgentRuntime {
  const sink = outbound ? { id: "discord", ...outbound } : undefined;
  return {
    getConfig: () => ({ channels: { discord: { owner: "owner-1" } } }),
    getOutbound: (id: string) => (id === "discord" ? sink : undefined),
    getOwnerId: (id?: string) => (id === "discord" || id === undefined ? "owner-1" : undefined),
  } as unknown as AgentRuntime;
}

// `deliver` is private; call it through a cast in tests.
function deliver(runtime: AgentRuntime, job: CronJobConfig, response: string): Promise<void> {
  const scheduler = new CronScheduler({ runtime });
  return (scheduler as unknown as { deliver(j: CronJobConfig, r: string): Promise<void> }).deliver(job, response);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

const job = (delivery?: CronJobConfig["delivery"]): CronJobConfig => ({
  name: "j",
  schedule: "* * * * *",
  prompt: "p",
  delivery,
});

describe("CronScheduler.deliver — open delivery shape (#142)", () => {
  it("logs to console for the 'log' sentinel and does not call the outbound", async () => {
    const send = vi.fn();
    const sendDM = vi.fn();
    await deliver(makeRuntime({ send, sendDM }), job({ channel: "log" }), "hello");
    expect(send).not.toHaveBeenCalled();
    expect(sendDM).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it("defaults to the 'log' sentinel when delivery is unconfigured", async () => {
    const send = vi.fn();
    const sendDM = vi.fn();
    await deliver(makeRuntime({ send, sendDM }), job(undefined), "hello");
    expect(send).not.toHaveBeenCalled();
    expect(sendDM).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
  });

  it("channel mode posts via send to the target room", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliver(
      makeRuntime({ send, sendDM: vi.fn() }),
      job({ channel: "discord", mode: "channel", target: "room-1" }),
      "msg",
    );
    expect(send).toHaveBeenCalledWith("room-1", "msg");
  });

  it("channel mode (default) posts via send when no mode is set", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await deliver(makeRuntime({ send, sendDM: vi.fn() }), job({ channel: "discord", target: "room-2" }), "msg");
    expect(send).toHaveBeenCalledWith("room-2", "msg");
  });

  it("dm mode sends via sendDM to the target user", async () => {
    const sendDM = vi.fn().mockResolvedValue(undefined);
    await deliver(
      makeRuntime({ send: vi.fn(), sendDM }),
      job({ channel: "discord", mode: "dm", target: "user-1" }),
      "msg",
    );
    expect(sendDM).toHaveBeenCalledWith("user-1", "msg");
  });

  it("dm mode falls back to the channel owner when no target is set", async () => {
    const sendDM = vi.fn().mockResolvedValue(undefined);
    await deliver(makeRuntime({ send: vi.fn(), sendDM }), job({ channel: "discord", mode: "dm" }), "msg");
    expect(sendDM).toHaveBeenCalledWith("owner-1", "msg");
  });

  it("logs an error (no throw) when the target channel is not connected", async () => {
    // No outbound registered → getOutbound("discord") is undefined.
    await expect(
      deliver(makeRuntime(), job({ channel: "discord", mode: "dm", target: "user-1" }), "msg"),
    ).resolves.toBeUndefined();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("not connected"))).toBe(true);
  });

  it("logs an error when channel mode has no target", async () => {
    const send = vi.fn();
    await deliver(makeRuntime({ send, sendDM: vi.fn() }), job({ channel: "discord", mode: "channel" }), "msg");
    expect(send).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("no target channel id"))).toBe(true);
  });
});
