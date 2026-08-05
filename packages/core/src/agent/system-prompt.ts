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
   * Only applies to layers that also appear in `order`. Defaults to
   * DEFAULT_TAIL_LAYERS; set `[]` to keep everything in the system prompt.
   */
  tail?: string[];
  /** Custom layers. Reference them by name in `order` to insert. */
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
 * Which layers render after the history rather than inside the system prompt.
 *
 * Intersected with `order`, so `order` keeps its "names not listed are omitted"
 * meaning: a layer stripped there stays stripped rather than reappearing in the
 * tail. `base` is never eligible — it is the prompt.
 */
export function resolveTailLayers(override: SystemPromptOverride | undefined): string[] {
  // An explicit `order` is a statement about placement, so the default tail
  // does not get to overrule it — that deployment opts in by naming `tail`.
  if (override?.tail === undefined && override?.order !== undefined) return [];
  const requested = override?.tail ?? DEFAULT_TAIL_LAYERS;
  const inOrder = new Set<string>(override?.order ?? DEFAULT_LAYER_ORDER);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    if (name === "base") {
      console.warn(`[system-prompt] Layer "base" cannot move to the tail — ignoring`);
      continue;
    }
    if (seen.has(name) || !inOrder.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
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

export function composeSystemPrompt(
  base: string,
  builtIn: BuiltInLayers,
  override: SystemPromptOverride | undefined,
  customContent: Record<string, string>,
): string {
  const order = override?.order ?? DEFAULT_LAYER_ORDER;
  const tail = new Set(resolveTailLayers(override));
  const blocks: Record<string, string> = {
    base,
    ...builtIn,
    ...customContent,
  };
  return collect(
    [...order].filter((name) => !tail.has(name)),
    blocks,
    "order",
  ).join("");
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
  const tail = resolveTailLayers(override);
  if (tail.length === 0) return "";
  const blocks: Record<string, string> = { ...builtIn, ...customContent };
  return collect(tail, blocks, "tail").join("").trim();
}
