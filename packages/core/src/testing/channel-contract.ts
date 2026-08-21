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
import type { Channel } from "../channels/interface.js";
import { createPluginContext, type Plugin } from "../plugin-context.js";

export interface OutboundCapture {
  target: string;
  content: string;
}

export interface ChannelContractHarness<C extends Channel = Channel> {
  /** Build a fresh channel. Called once per test so state never leaks. */
  build(): C | Promise<C>;
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

    it("declares surface capabilities", async () => {
      // A capability struct nobody asserts is a capability struct nobody fills
      // in — which is precisely how `AIProvider.supportsTools` spent its life
      // declared on every provider and read by nothing. The contract is where
      // that gets prevented for surfaces.
      const channel = await harness.build();
      const caps = channel.capabilities;
      expect(
        caps,
        "Channel.capabilities is required — spread TEXT_ONLY_SURFACE if there is nothing to declare",
      ).toBeDefined();
      expect(typeof caps.inlineMedia).toBe("boolean");
      expect(typeof caps.attachments).toBe("boolean");
      expect(typeof caps.links).toBe("boolean");
      expect(caps.maxMessageLength).toBeGreaterThan(0);
      // A surface that takes uploads has to say how big, or the ladder cannot
      // tell "fits" from "will be rejected by the API".
      if (caps.attachments)
        expect(caps.maxBytes, "a surface accepting uploads must declare maxBytes").toBeGreaterThan(0);
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
        const match = sent.find((m) => m.target === "contract-target" && m.content.includes("hello from contract"));
        expect(match, `expected drainSent() to contain a write to "contract-target"`).toBeDefined();
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
