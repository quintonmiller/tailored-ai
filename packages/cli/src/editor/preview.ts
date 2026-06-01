// Pure helpers shared between the Ink app and the setup writers. Both the live
// YAML pane and the save-time diff display call these.

import { diffLines } from "diff";
import { hydrateFromYaml, patchExistingYaml, renderNewConfig } from "../setup.js";
import type { DraftConfig } from "./types.js";

export interface PreviewResult {
  text: string;
  changes: string[];
}

/** Preview YAML for an existing config — applies draft changes on top of original. */
export function previewExisting(originalText: string, draft: DraftConfig): PreviewResult {
  const original = hydrateFromYaml(originalText, draft.homeDir);
  return patchExistingYaml(originalText, original, draft);
}

/** Preview YAML for a fresh install — renders the full template. */
export function previewNew(draft: DraftConfig): PreviewResult {
  return { text: renderNewConfig(draft), changes: [] };
}

export interface DiffLine {
  kind: "add" | "remove" | "context";
  text: string;
}

/** Produce a flat list of diff lines for display. Context kept tight (≤2 lines either side). */
export function computeDiff(before: string, after: string): DiffLine[] {
  if (before === after) return [];
  const chunks = diffLines(before, after);
  const out: DiffLine[] = [];
  for (const chunk of chunks) {
    const lines = chunk.value.replace(/\n$/, "").split("\n");
    const kind = chunk.added ? "add" : chunk.removed ? "remove" : "context";
    for (const line of lines) out.push({ kind, text: line });
  }
  return out;
}
