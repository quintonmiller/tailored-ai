import { type Disposer, Registry } from "../registry.js";
import type { AgentRuntime } from "../runtime.js";
import type { UiProvider } from "./interface.js";

/**
 * Construct a UI provider for the active runtime. May read its own slice
 * of config from `server.ui.<id>` if it needs configuration. Returning
 * undefined means "no UI for this run" (e.g. dist directory missing).
 */
export type UiProviderFactory = (
  runtime: AgentRuntime,
  config: Record<string, unknown>,
) => Promise<UiProvider | undefined> | UiProvider | undefined;

export const uiProviderFactoryRegistry = new Registry<UiProviderFactory>("ui-provider");

export function registerUiProviderFactory(id: string, factory: UiProviderFactory): Disposer {
  return uiProviderFactoryRegistry.register(id, factory);
}

/**
 * Resolve the UI provider declared by `server.ui.provider` (defaults to
 * "builtin"). Returns undefined when:
 *   - `server.ui.enabled` is explicitly false (kill-switch for headless), or
 *   - no factory is registered for the declared id, or
 *   - the factory itself returns undefined.
 *
 * Unknown ids log a warning but don't throw — keeps the server bootable
 * when a plugin fails to load.
 */
export async function resolveUiProvider(runtime: AgentRuntime): Promise<UiProvider | undefined> {
  const ui = runtime.getConfig().server.ui;
  if (ui?.enabled === false) return undefined;

  const id = ui?.provider ?? "builtin";
  const factory = uiProviderFactoryRegistry.get(id);
  if (!factory) {
    const known = uiProviderFactoryRegistry.list().join(", ") || "(none)";
    console.warn(
      `[ui] No factory registered for server.ui.provider="${id}". Known: ${known}. ` +
        `Register one with registerUiProviderFactory(). Skipping UI mount.`,
    );
    return undefined;
  }

  const slice = (ui as Record<string, unknown> | undefined)?.[id];
  const cfg = (slice && typeof slice === "object" ? (slice as Record<string, unknown>) : {}) ?? {};
  return factory(runtime, cfg);
}
