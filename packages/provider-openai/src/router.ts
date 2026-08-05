/**
 * Endpoint routing per call (#378).
 *
 * The provider registry builds one provider from `providers.openai`, but which
 * endpoint a request needs is a property of the *model*, and the model is not
 * fixed at build time: an agent can pin its own, a per-call override can name
 * another, and a fallback chain rung can carry a third. Choosing from
 * `defaultModel` when the provider is constructed would silently send an
 * overridden model to the wrong endpoint — the same class of bug as an agent's
 * `provider:` being ignored.
 *
 * So the choice is made per call, against `params.model`.
 */
import type { AIProvider, ChatParams, ChatResponse, ChatStreamEvent } from "@tailored-ai/core";

export interface OpenAIRouterOptions {
  chat: AIProvider;
  responses: AIProvider;
  /** Endpoint for a given model id. */
  select: (model: string) => "chat" | "responses";
}

/**
 * Dispatches each call to the chat-completions or Responses provider. Holds
 * both, so the learned per-model quirks each accumulates survive across calls
 * rather than being rebuilt per turn.
 */
export class OpenAIRouterProvider implements AIProvider {
  id = "openai";
  name = "OpenAI";
  supportsTools = true;

  private chatProvider: AIProvider;
  private responsesProvider: AIProvider;
  private select: (model: string) => "chat" | "responses";

  constructor(opts: OpenAIRouterOptions) {
    this.chatProvider = opts.chat;
    this.responsesProvider = opts.responses;
    this.select = opts.select;
  }

  /** Exposed so callers (and tests) can see where a model would go. */
  providerFor(model: string): AIProvider {
    return this.select(model) === "responses" ? this.responsesProvider : this.chatProvider;
  }

  chat(params: ChatParams): Promise<ChatResponse> {
    return this.providerFor(params.model).chat(params);
  }

  chatStream(params: ChatParams): AsyncIterable<ChatStreamEvent> {
    const target = this.providerFor(params.model);
    if (!target.chatStream) {
      throw new Error(`${target.name} does not support streaming`);
    }
    return target.chatStream(params);
  }

  /** Either provider answers this identically; the chat one is always present. */
  listModels(): Promise<string[]> {
    if (!this.chatProvider.listModels) throw new Error("model discovery is not available");
    return this.chatProvider.listModels();
  }
}
