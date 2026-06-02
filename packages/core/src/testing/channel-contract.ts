/**
 * Shared vitest suite that any {@link Channel} implementation can plug into to
 * prove it satisfies the contract. Inspired by the MemoryBackend Phase 3
 * acceptance test — the goal is that a new channel package (Slack, Telegram,
 * iMessage, ...) gets its contract coverage in ~10 LOC instead of re-deriving
 * the asserts from Discord's source.
 *
 * Authored channels supply a {@link ChannelContractHarness} that knows how to:
 *   - build a channel instance (typically with the transport stubbed)
 *   - simulate an incoming event reaching the underlying transport
 *   - drain the outbound writes the channel has performed
 *
 * The suite calls into the harness; transport details (Bolt, discord.js,
 * matrix-js-sdk) stay inside the channel package's test setup.
 */

import { describe, expect, it, vi } from "vitest";
import type { Channel, IncomingMessage } from "../channels/interface.js";
import { createPluginContext, type Plugin } from "../plugin-context.js";

export interface OutboundCapture {
  target: string;
  content: string;
}

export interface ChannelContractHarness<C extends Channel = Channel> {
  /** Build a fresh channel. Called once per test so state never leaks. */
  build(): C | Promise<C>;
  /**
   * Push a fake incoming event into the channel's transport after
   * `connect()` has resolved. Implementations typically call into the
   * stubbed Bolt/discord.js client they wired up in `build()`.
   *
   * When omitted, the `onMessage` test is skipped.
   */
  emitIncoming?(channel: C, msg: IncomingMessage): void | Promise<void>;
  /**
   * Return the messages the channel has sent via `send()` (or, if the
   * channel implements `OutboundNotifier`, via `sendDM`). The helper
   * drains this between assertions, so implementations can return either
   * a snapshot or the live buffer.
   *
   * When omitted, the `send()` round-trip test is skipped.
   */
  drainSent?(channel: C): OutboundCapture[];
}

export interface ChannelContractOptions<C extends Channel = Channel> {
  /** Channel id under test — used in describe() and the plugin assertion. */
  name: string;
  harness: ChannelContractHarness<C>;
  /**
   * When provided, the suite asserts the plugin's default export registers
   * `name` into the channels namespace when invoked with a PluginContext.
   */
  plugin?: Plugin;
}

/**
 * Drive a {@link Channel} implementation through the contract suite. Call from
 * a vitest test file — the helper invokes `describe`/`it`/`expect` directly.
 *
 *     import { runChannelContractSuite } from "@tailored-ai/core/testing";
 *
 *     runChannelContractSuite({
 *       name: "slack",
 *       plugin,
 *       harness: {
 *         build: () => new SlackChannel({ runtime: fakeRuntime, config }),
 *         emitIncoming: (c, msg) => fakeBolt.deliverMessage(msg),
 *         drainSent: () => fakeBolt.sentMessages,
 *       },
 *     });
 */
export function runChannelContractSuite<C extends Channel>(opts: ChannelContractOptions<C>): void {
  const { name, harness, plugin } = opts;

  describe(`Channel contract: ${name}`, () => {
    it("exposes a non-empty id and type", async () => {
      const channel = await harness.build();
      expect(typeof channel.id).toBe("string");
      expect(channel.id.length).toBeGreaterThan(0);
      expect(typeof channel.type).toBe("string");
      expect(channel.type.length).toBeGreaterThan(0);
    });

    it("connect() then disconnect() resolves cleanly", async () => {
      const channel = await harness.build();
      await channel.connect();
      await channel.disconnect();
    });

    it("disconnect() before connect() does not throw", async () => {
      const channel = await harness.build();
      await channel.disconnect();
    });

    if (harness.drainSent) {
      it("send(target, content) routes content to the target", async () => {
        const channel = await harness.build();
        await channel.connect();
        await channel.send("contract-target", "hello from contract");
        const sent = harness.drainSent!(channel);
        expect(sent.length).toBeGreaterThan(0);
        const match = sent.find(
          (m) => m.target === "contract-target" && m.content.includes("hello from contract"),
        );
        expect(match, `expected drainSent() to contain a write to "contract-target"`).toBeDefined();
        await channel.disconnect();
      });
    }

    if (harness.emitIncoming) {
      it("onMessage handler fires when an incoming event arrives", async () => {
        const channel = await harness.build();
        const handler = vi.fn();
        channel.onMessage(handler);
        await channel.connect();
        const fake: IncomingMessage = {
          id: "contract-msg-1",
          channelId: "contract-room",
          authorId: "contract-user",
          authorName: "Contract Tester",
          content: "ping",
          isDM: false,
          isMention: true,
        };
        await harness.emitIncoming!(channel, fake);
        expect(handler).toHaveBeenCalled();
        const arg = handler.mock.calls[0]?.[0] as IncomingMessage | undefined;
        expect(arg?.content).toContain("ping");
        await channel.disconnect();
      });

      it("onMessage handler is not fired before connect()", async () => {
        const channel = await harness.build();
        const handler = vi.fn();
        channel.onMessage(handler);
        // Don't connect — the channel should not be receiving events yet.
        expect(handler).not.toHaveBeenCalled();
        await channel.disconnect();
      });
    }

    if (plugin) {
      it(`plugin default export registers "${name}" into ctx.channels`, async () => {
        const ctx = createPluginContext();
        const spy = vi.spyOn(ctx.channels, "register");
        await plugin(ctx);
        expect(spy).toHaveBeenCalledWith(name, expect.any(Function));
      });
    }
  });
}
