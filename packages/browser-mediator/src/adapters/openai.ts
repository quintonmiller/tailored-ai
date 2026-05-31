/**
 * OpenAI function-calling adapter.
 *
 * Usage with the OpenAI Node SDK (chat.completions):
 *
 *   const mediator = new BrowserMediator({ egressAllowList: [...] });
 *   const tool = openaiToolSpec(); // pass into chat.completions.create({tools: [tool]})
 *   const response = await client.chat.completions.create({tools: [tool], ...});
 *
 *   for (const call of response.choices[0].message.tool_calls ?? []) {
 *     if (call.function.name === TOOL_NAME) {
 *       const result = await handleOpenAIToolCall(mediator, call.function.arguments);
 *       // feed `result.content` back as a tool message
 *     }
 *   }
 */
import type { BrowserMediator } from "../mediator.js";
import { dispatchToMediator, TOOL_DESCRIPTION, TOOL_NAME, TOOL_PARAMETERS } from "./dispatch.js";

export interface OpenAIToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Returns the tool spec object passed to OpenAI's `tools:` array. */
export function openaiToolSpec(): OpenAIToolSpec {
  return {
    type: "function",
    function: {
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS as unknown as Record<string, unknown>,
    },
  };
}

export interface OpenAIToolCallResult {
  /** Plain string content suitable for `{ role: "tool", content }`. */
  content: string;
  /** Whether the call succeeded (mirrors the dispatcher). */
  ok: boolean;
}

/**
 * Handle one tool_call from an OpenAI chat-completions response.
 * `argsJson` is the `function.arguments` string from the tool call.
 */
export async function handleOpenAIToolCall(mediator: BrowserMediator, argsJson: string): Promise<OpenAIToolCallResult> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(argsJson || "{}");
  } catch (err) {
    return { ok: false, content: `Invalid JSON arguments: ${(err as Error).message}` };
  }
  const r = await dispatchToMediator(mediator, parsed);
  return {
    ok: r.ok,
    content: r.ok ? r.output : `error: ${r.error}`,
  };
}

export { TOOL_DESCRIPTION, TOOL_NAME } from "./dispatch.js";
