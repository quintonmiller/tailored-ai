/**
 * Self-test for the `runChannelContractSuite` helper. Builds a minimal
 * in-memory Channel + Plugin and drives it through the contract suite — if
 * the helper itself ever stops asserting the right things, this test breaks.
 */

import type { Channel, IncomingMessage } from "../channels/interface.js";
import type { Plugin } from "../plugin-context.js";
import { runChannelContractSuite } from "../testing/channel-contract.js";

class InMemoryChannel implements Channel {
  readonly id = "in-memory";
  readonly type = "in-memory";
  connected = false;
  sent: { target: string; content: string }[] = [];
  private handler?: (msg: IncomingMessage) => void;

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }
  async send(target: string, content: string): Promise<void> {
    this.sent.push({ target, content });
  }
  deliver(msg: IncomingMessage): void {
    if (!this.connected) return;
    this.handler?.(msg);
  }
}

const inMemoryPlugin: Plugin = (ctx) => {
  ctx.channels.register("in-memory", async () => undefined);
};

runChannelContractSuite<InMemoryChannel>({
  name: "in-memory",
  plugin: inMemoryPlugin,
  harness: {
    build: () => new InMemoryChannel(),
    emitIncoming: (channel, msg) => channel.deliver(msg),
    drainSent: (channel) => channel.sent,
  },
});
