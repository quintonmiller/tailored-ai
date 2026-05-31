/**
 * Anthropic Claude tool-use adapter.
 *
 * Usage with the @anthropic-ai/sdk:
 *
 *   const mediator = new BrowserMediator({ egressAllowList: [...] });
 *   const tool = anthropicToolSpec();
 *   const response = await client.messages.create({tools: [tool], ...});
 *
 *   for (const block of response.content) {
 *     if (block.type === "tool_use" && block.name === TOOL_NAME) {
 *       const result = await handleAnthropicToolCall(mediator, block.input);
 *       // feed result back as a `tool_result` content block
 *     }
 *   }
 */
import type { BrowserMediator } from "../mediator.js";
import { dispatchToMediator, TOOL_DESCRIPTION, TOOL_NAME, TOOL_PARAMETERS } from "./dispatch.js";

export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Returns the tool spec object passed to Anthropic's `tools:` array. */
export function anthropicToolSpec(): AnthropicToolSpec {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    input_schema: TOOL_PARAMETERS as unknown as Record<string, unknown>,
  };
}

export interface AnthropicToolResult {
  /** Plain string content suitable for a `tool_result` block. */
  content: string;
  /** `is_error` flag for the `tool_result` block. */
  is_error: boolean;
}

/**
 * Handle one tool_use block from a Claude response.
 * `input` is the parsed `block.input` object (already a JS object).
 */
export async function handleAnthropicToolCall(
  mediator: BrowserMediator,
  input: Record<string, unknown>,
): Promise<AnthropicToolResult> {
  const r = await dispatchToMediator(mediator, input);
  return {
    is_error: !r.ok,
    content: r.ok ? r.output : (r.error ?? "error"),
  };
}

export { TOOL_DESCRIPTION, TOOL_NAME } from "./dispatch.js";
