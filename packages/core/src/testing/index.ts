/**
 * Test-only helpers for plugin authors. Consumed via the
 * `@tailored-ai/core/testing` subpath so vitest stays out of the main
 * runtime bundle.
 */
export {
  type ChannelContractHarness,
  type ChannelContractOptions,
  type OutboundCapture,
  runChannelContractSuite,
} from "./channel-contract.js";
export {
  assertValidChatResponse,
  type ProviderContractHarness,
  type ProviderContractOptions,
  runProviderContractSuite,
} from "./provider-contract.js";
