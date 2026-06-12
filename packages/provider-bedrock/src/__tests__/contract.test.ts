/**
 * Contract coverage via core's shared provider suite (#226). The stub
 * answers Converse with a fixed completion and ConverseStream with a
 * two-delta stream, so the suite's streaming invariants run for real.
 */
import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { runProviderContractSuite } from "@tailored-ai/core/testing";
import { BedrockProvider } from "../provider.js";

function stubClient() {
  return {
    send: async (cmd: unknown) => {
      if (cmd instanceof ConverseStreamCommand) {
        return {
          stream: (async function* () {
            yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "O" } } };
            yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "K" } } };
            yield { messageStop: { stopReason: "end_turn" } };
            yield { metadata: { usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, metrics: {} } };
          })(),
        };
      }
      return {
        output: { message: { role: "assistant", content: [{ text: "OK" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      };
    },
  };
}

runProviderContractSuite({
  name: "bedrock",
  harness: {
    build: () => new BedrockProvider({ client: stubClient() as never }),
    params: { model: "us.amazon.nova-micro-v1:0" },
  },
});
