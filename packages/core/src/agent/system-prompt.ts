import { existsSync, readFileSync } from "node:fs";
import { BASE_SYSTEM_PROMPT } from "./prompt.js";

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

export function resolveBase(override: SystemPromptOverride | undefined): string {
  if (override?.base !== undefined) return override.base;
  if (override?.baseFile) {
    if (!existsSync(override.baseFile)) {
      console.warn(`[system-prompt] baseFile "${override.baseFile}" not found — falling back to BASE_SYSTEM_PROMPT`);
      return BASE_SYSTEM_PROMPT;
    }
    return readFileSync(override.baseFile, "utf8");
  }
  return BASE_SYSTEM_PROMPT;
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

export function composeSystemPrompt(
  base: string,
  builtIn: BuiltInLayers,
  override: SystemPromptOverride | undefined,
  customContent: Record<string, string>,
): string {
  const order = override?.order ?? DEFAULT_LAYER_ORDER;
  const blocks: Record<string, string> = {
    base,
    ...builtIn,
    ...customContent,
  };
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const name of order) {
    if (seen.has(name)) {
      console.warn(`[system-prompt] Duplicate layer "${name}" in order — skipping second occurrence`);
      continue;
    }
    seen.add(name);
    if (name in blocks) {
      parts.push(blocks[name]);
    } else {
      console.warn(`[system-prompt] Unknown layer "${name}" in order — skipping`);
    }
  }
  return parts.join("");
}
