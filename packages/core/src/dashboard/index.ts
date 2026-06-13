/**
 * Dashboard widget seam.
 *
 * The bundled UI's Board page renders a list of *declarative widget specs* —
 * data, not React code. This is what lets a custom dashboard "slot into the
 * real dashboard" without forking the UI:
 *
 *   - Core owns the seam: the {@link DashboardWidget} contract, a registry of
 *     widget *providers*, and {@link resolveDashboardWidgets} which merges
 *     provider output with the user's `dashboard.widgets` config.
 *   - Plugins contribute widgets by calling {@link registerDashboardWidgetProvider}.
 *   - Personal setups add/override/reorder widgets via `dashboard.widgets` in
 *     config.yaml.
 *   - The UI ships a set of generic *renderer types* (`status`, `metric`,
 *     `tasks`, `list`, `markdown`, `links`, `iframe`, …); a widget's `type`
 *     selects one. New types can be added in the UI without touching this seam.
 *
 * Specs are intentionally renderer-agnostic here: core never imports React and
 * stays ignorant of how a widget looks. It only knows the shape of the spec and
 * how to assemble the effective list. See docs/dashboard-widgets.md.
 */

import type { AgentConfig } from "../config.js";
import { Registry } from "../registry.js";

/** A single dashboard widget, expressed as data the UI knows how to render. */
export interface DashboardWidget {
  /** Stable unique id. Config entries with the same id override providers. */
  id: string;
  /** Renderer type the UI maps to a component (e.g. "status", "tasks"). */
  type: string;
  /** Heading shown on the widget card. Optional for chrome-less types. */
  title?: string;
  /** Column span hint, 1–4. The grid clamps out-of-range values. Default 1. */
  span?: number;
  /** Sort key; lower renders first. Default 100. */
  order?: number;
  /** Set false to hide without deleting the entry. Default true (shown). */
  enabled?: boolean;
  /** Renderer-specific options — opaque to core (endpoint, fields, url, …). */
  options?: Record<string, unknown>;
}

/**
 * Produces zero or more widgets from the current config. Registered by plugins
 * (and the built-in default provider). Return `undefined`/`[]` to contribute
 * nothing — e.g. when a feature the widget depends on is disabled.
 */
export type DashboardWidgetProvider = (config: AgentConfig) => DashboardWidget[] | undefined;

/** Runtime registry of widget providers (built-ins register like third parties). */
export const dashboardWidgetRegistry = new Registry<DashboardWidgetProvider>("dashboard-widget");

/** Register a widget provider under a stable id (idempotent replace on reload). */
export function registerDashboardWidgetProvider(id: string, provider: DashboardWidgetProvider): void {
  dashboardWidgetRegistry.register(id, provider);
}

/**
 * Build the effective, ordered widget list for the Board page.
 *
 * Precedence: provider widgets first, then `config.dashboard.widgets` — a
 * config entry sharing a provider widget's `id` shallow-merges over it (so a
 * personal setup can re-title, re-span, reorder, or disable a built-in widget
 * without redefining it). Disabled widgets are dropped; the rest sort by
 * `order` then `title`.
 */
export function resolveDashboardWidgets(config: AgentConfig): DashboardWidget[] {
  const fromProviders: DashboardWidget[] = [];
  for (const [, provider] of dashboardWidgetRegistry.entriesList()) {
    try {
      const widgets = provider(config);
      if (widgets) fromProviders.push(...widgets);
    } catch (err) {
      // A misbehaving provider must not take down the whole board.
      console.warn(`[dashboard-widget-registry] provider threw, skipping: ${(err as Error).message}`);
    }
  }

  const byId = new Map<string, DashboardWidget>();
  for (const w of [...fromProviders, ...(config.dashboard?.widgets ?? [])]) {
    if (!w?.id || !w?.type) continue; // ignore malformed entries
    const existing = byId.get(w.id);
    byId.set(w.id, existing ? { ...existing, ...w } : w);
  }

  return [...byId.values()]
    .filter((w) => w.enabled !== false)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || (a.title ?? "").localeCompare(b.title ?? ""));
}
