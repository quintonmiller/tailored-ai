/**
 * TAI (Tailored AI) Tool adapter.
 *
 * Used by `@tailored-ai/core/factories.ts` to register the mediator as
 * a regular Tool — keeps the framework-agnostic mediator code clean
 * and lets TAI evolve its Tool interface independently of the
 * mediator's own API.
 */
import { BrowserMediator, type BrowserMediatorOptions } from "../mediator.js";
import { dispatchToMediator, TOOL_DESCRIPTION, TOOL_NAME, TOOL_PARAMETERS } from "./dispatch.js";

/**
 * Minimal contract matching the shape of TAI's `Tool` interface. We
 * intentionally don't import from `@tailored-ai/core` so this package
 * stays standalone — the structural type matches the real interface.
 */
export interface TaiToolLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    context: unknown,
  ): Promise<{ success: boolean; output: string; error?: string }>;
}

export interface TaiAdapterConfig extends BrowserMediatorOptions {
  /** Optional pre-built mediator (e.g. shared across tools). */
  mediator?: BrowserMediator;
}

/**
 * Build a TAI-shaped Tool instance backed by a BrowserMediator.
 * Reuses one mediator across calls so element ids stay stable.
 */
export function createTaiTool(config: TaiAdapterConfig = {}): TaiToolLike {
  const mediator = config.mediator ?? new BrowserMediator(config);
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS as unknown as Record<string, unknown>,
    async execute(args) {
      const r = await dispatchToMediator(mediator, args);
      return { success: r.ok, output: r.output, error: r.error };
    },
  };
}
