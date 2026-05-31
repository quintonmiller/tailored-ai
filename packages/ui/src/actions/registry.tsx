import type { ComponentType } from "react";
import { PurchaseAmazonCard } from "./PurchaseAmazonCard";

/**
 * Pluggable renderer registry: maps an action type string to a React component.
 *
 * The executor classifies actions by `type` (e.g. "purchase.amazon").
 * The UI looks up the type in this registry and renders the matching card.
 * Unknown types fall back to a generic display.
 */
export interface ActionRenderer {
  /** Unique action type identifier, e.g. "purchase.amazon" */
  type: string;
  /** React component that renders the action card */
  component: ComponentType<{ input: Record<string, unknown> }>;
}

const RENDERERS: ActionRenderer[] = [{ type: "purchase.amazon", component: PurchaseAmazonCard }];

/**
 * Resolve an action type to its renderer component.
 * Returns `undefined` for unknown types (caller should render a fallback).
 */
export function getRenderer(type: string): ComponentType<{ input: Record<string, unknown> }> | undefined {
  const entry = RENDERERS.find((r) => r.type === type);
  return entry?.component;
}

/** Register a new renderer at runtime (e.g. from a lazy-loaded plugin). */
export function registerRenderer(renderer: ActionRenderer): void {
  const idx = RENDERERS.findIndex((r) => r.type === renderer.type);
  if (idx >= 0) {
    RENDERERS[idx] = renderer;
  } else {
    RENDERERS.push(renderer);
  }
}
