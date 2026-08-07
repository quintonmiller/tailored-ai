import { existsSync, readFileSync } from "node:fs";
import { type BasePromptOptions, buildBaseSystemPrompt } from "./prompt.js";

export const DEFAULT_LAYER_ORDER = [
  "base",
  "instructions",
  "context",
  "skill_catalog",
  "core_memory",
  "chat_live_state",
  "recall_memory",
] as const;

export type DefaultLayerName = (typeof DEFAULT_LAYER_ORDER)[number];

export interface CustomLayer {
  name: string;
  content?: string;
  file?: string;
}

export interface SystemPromptOverride {
  /** Inline replacement for BASE_SYSTEM_PROMPT. Takes precedence over baseFile. */
  base?: string;
  /** Path to a file holding the base prompt. Read on every compose so edits take effect without a restart. */
  baseFile?: string;
  /**
   * Layer names in the desired order. Names not listed are omitted (use this
   * to strip). Unknown names emit a warning. When undefined, DEFAULT_LAYER_ORDER applies.
   */
  order?: string[];
  /**
   * Layers to render *after* the message history instead of inside the system
   * prompt, as a trailing turn. Prompt caching matches an exact token prefix,
   * so anything rebuilt per turn invalidates the cache for everything after it
   * — and the system prompt sits in front of the entire history. Moving the
   * volatile layers behind the history leaves the prompt and the history as a
   * stable prefix.
   *
   * Applies to layers that appear in `order`, and to any declared `custom`
   * layer. Defaults to DEFAULT_TAIL_LAYERS; set `[]` to keep everything in the
   * system prompt.
   *
   * Setting `order` without `tail` switches the tail off entirely and warns —
   * see `resolveTailLayers`.
   */
  tail?: string[];
  /**
   * Custom layers. Declaring one is enough to render it: unplaced layers are
   * appended after the built-ins. Name it in `order` or `tail` to place it
   * somewhere specific.
   */
  custom?: CustomLayer[];
}

export interface BuiltInLayers {
  instructions: string;
  context: string;
  skill_catalog: string;
  core_memory: string;
  chat_live_state: string;
  recall_memory: string;
}

/**
 * Merge a global override with a per-agent override. Per-agent fields win
 * field-by-field; list-shaped fields (`order`, `custom`) replace wholesale
 * rather than concatenating, since merging layer orders has no obvious
 * semantics. Returns undefined when both inputs are undefined so callers can
 * cheaply check "no override at all."
 */
export function mergeSystemPromptOverrides(
  global: SystemPromptOverride | undefined,
  perAgent: SystemPromptOverride | undefined,
): SystemPromptOverride | undefined {
  if (!global && !perAgent) return undefined;
  if (!global) return perAgent;
  if (!perAgent) return global;
  const merged: SystemPromptOverride = {};
  if (perAgent.base !== undefined) {
    merged.base = perAgent.base;
  } else if (perAgent.baseFile !== undefined) {
    merged.baseFile = perAgent.baseFile;
  } else if (global.base !== undefined) {
    merged.base = global.base;
  } else if (global.baseFile !== undefined) {
    merged.baseFile = global.baseFile;
  }
  merged.order = perAgent.order ?? global.order;
  merged.tail = perAgent.tail ?? global.tail;
  merged.custom = perAgent.custom ?? global.custom;
  return merged;
}

/**
 * `opts` shapes the built-in base only. An explicit `base`/`baseFile` override
 * is returned verbatim: a deployment that wrote its own base prompt owns every
 * sentence in it, and silently appending a paragraph would be the same class of
 * surprise this parameter exists to remove.
 */
export function resolveBase(override: SystemPromptOverride | undefined, opts?: BasePromptOptions): string {
  if (override?.base !== undefined) return override.base;
  if (override?.baseFile) {
    if (!existsSync(override.baseFile)) {
      console.warn(`[system-prompt] baseFile "${override.baseFile}" not found — falling back to the built-in base`);
      return buildBaseSystemPrompt(opts);
    }
    return readFileSync(override.baseFile, "utf8");
  }
  return buildBaseSystemPrompt(opts);
}

export function resolveCustomLayers(custom: CustomLayer[] | undefined): Record<string, string> {
  if (!custom) return {};
  const out: Record<string, string> = {};
  const builtIn = new Set<string>(DEFAULT_LAYER_ORDER);
  for (const layer of custom) {
    if (builtIn.has(layer.name)) {
      console.warn(`[system-prompt] Custom layer name "${layer.name}" collides with a built-in layer — skipping`);
      continue;
    }
    let content = "";
    if (layer.content !== undefined) {
      content = layer.content;
    } else if (layer.file) {
      if (existsSync(layer.file)) {
        content = readFileSync(layer.file, "utf8");
      } else {
        console.warn(
          `[system-prompt] Custom layer "${layer.name}" file "${layer.file}" not found — using empty content`,
        );
      }
    }
    out[layer.name] = content;
  }
  return out;
}

/**
 * Layers that are rebuilt from scratch on every turn, and so are moved out of
 * the system prompt by default (see `SystemPromptOverride.tail`).
 */
export const DEFAULT_TAIL_LAYERS = ["chat_live_state", "recall_memory"] as const;

/**
 * Tracks which `order`-without-`tail` configurations have already been reported,
 * so the warning below fires once per distinct config rather than on every turn.
 * Composing happens twice per turn (prompt, then tail) and every turn, so an
 * undeduped warning here would be several thousand identical lines a day.
 */
const warnedOrderWithoutTail = new Set<string>();

/**
 * Which layers render after the history rather than inside the system prompt.
 *
 * Intersected with `order`, so `order` keeps its "names not listed are omitted"
 * meaning: a layer stripped there stays stripped rather than reappearing in the
 * tail. `base` is never eligible — it is the prompt.
 *
 * `customNames` makes a declared custom layer eligible for the tail without
 * having to appear in `order` too. Without it, naming a custom layer in `tail`
 * silently did nothing, which is the same class of defect as the warning below.
 */
export function resolveTailLayers(override: SystemPromptOverride | undefined, customNames?: string[]): string[] {
  // An explicit `order` is a statement about placement, so the default tail
  // does not get to overrule it — that deployment opts in by naming `tail`.
  //
  // The behaviour stays; the silence does not. Setting `order` to add a layer
  // also switches off the tail, and the volatile layers then either sit in the
  // system prompt (invalidating the prompt cache on every turn, since they
  // carry the clock) or drop out of the request entirely. Neither is guessable
  // from the config, and both are things a deployment would want to know it had
  // just chosen.
  if (override?.tail === undefined && override?.order !== undefined) {
    const key = override.order.join(",");
    if (!warnedOrderWithoutTail.has(key)) {
      warnedOrderWithoutTail.add(key);
      const volatile = DEFAULT_TAIL_LAYERS.filter((name) => override.order?.includes(name));
      console.warn(
        `[system-prompt] systemPrompt.order is set without systemPrompt.tail, so no layer moves behind the history. ` +
          (volatile.length > 0
            ? `${volatile.join(", ")} will render inside the system prompt, which changes it every turn and defeats prompt caching. `
            : `${DEFAULT_TAIL_LAYERS.join(", ")} are not in your order, so they will not be sent at all. `) +
          `Set "tail" explicitly (tail: [${DEFAULT_TAIL_LAYERS.map((n) => `"${n}"`).join(", ")}]) to keep the default placement.`,
      );
    }
    return [];
  }
  const requested = override?.tail ?? DEFAULT_TAIL_LAYERS;
  const eligible = new Set<string>(override?.order ?? DEFAULT_LAYER_ORDER);
  for (const name of customNames ?? []) eligible.add(name);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    if (name === "base") {
      console.warn(`[system-prompt] Layer "base" cannot move to the tail — ignoring`);
      continue;
    }
    if (seen.has(name) || !eligible.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Test seam: the warning above is once-per-config for the life of the process. */
export function resetSystemPromptWarnings(): void {
  warnedOrderWithoutTail.clear();
}

function collect(names: Iterable<string>, blocks: Record<string, string>, where: string): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      console.warn(`[system-prompt] Duplicate layer "${name}" in ${where} — skipping second occurrence`);
      continue;
    }
    seen.add(name);
    if (name in blocks) {
      parts.push(blocks[name]);
    } else {
      console.warn(`[system-prompt] Unknown layer "${name}" in ${where} — skipping`);
    }
  }
  return parts;
}

/**
 * Custom layers that nobody placed still render.
 *
 * `order` means "names not listed are omitted", which is right for the built-in
 * layers — that is how a deployment strips one. Applied to *custom* layers it
 * meant something else: a layer you had just declared was dropped unless you
 * also rewrote the whole running order, so the common case (add one block) cost
 * you enumerating all seven built-ins, and getting that list wrong deleted a
 * built-in silently.
 *
 * Declaring a custom layer is now enough to render it. Naming it in `order` or
 * `tail` still decides *where*; leaving it unnamed appends it, which is the
 * behaviour someone adding a block already expects.
 */
function unplacedCustomLayers(
  customContent: Record<string, string>,
  order: readonly string[],
  tail: ReadonlySet<string>,
): string[] {
  const placed = new Set<string>(order);
  return Object.keys(customContent).filter((name) => !placed.has(name) && !tail.has(name));
}

export function composeSystemPrompt(
  base: string,
  builtIn: BuiltInLayers,
  override: SystemPromptOverride | undefined,
  customContent: Record<string, string>,
): string {
  const order = override?.order ?? DEFAULT_LAYER_ORDER;
  const tail = new Set(resolveTailLayers(override, Object.keys(customContent)));
  const blocks: Record<string, string> = {
    base,
    ...builtIn,
    ...customContent,
  };
  const placed = collect(
    [...order].filter((name) => !tail.has(name)),
    blocks,
    "order",
  );
  const appended = collect(unplacedCustomLayers(customContent, order, tail), blocks, "custom");
  return [...placed, ...appended].join("");
}

/**
 * Render the tail layers into the block that follows the history.
 *
 * Returns "" when nothing moves, so callers can skip the extra message
 * entirely rather than sending an empty one.
 */
export function composeTailBlock(
  builtIn: BuiltInLayers,
  override: SystemPromptOverride | undefined,
  customContent: Record<string, string>,
): string {
  const tail = resolveTailLayers(override, Object.keys(customContent));
  if (tail.length === 0) return "";
  const blocks: Record<string, string> = { ...builtIn, ...customContent };
  return collect(tail, blocks, "tail").join("").trim();
}
