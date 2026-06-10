import { assembleBriefingContext, type BriefingRuntime } from "./briefing.js";

/** A set of generated chat suggestions plus the timestamp they were produced. */
export interface Suggestions {
  suggestions: string[];
  generatedAt: number;
}

/** Subset of the runtime that {@link generateSuggestions} reads. Mirrors
 * {@link BriefingRuntime} so the two surfaces share context assembly and stay
 * unit-testable without a full AgentRuntime. */
export type SuggestionsRuntime = BriefingRuntime;

export interface GenerateSuggestionsOptions {
  /** Override the trailing window for "recent" activity. Default 24h. */
  windowHours?: number;
}

/** Hard cap on how many suggestions we'll ever return — keeps the chip row
 * bounded even if config asks for more. */
const MAX_COUNT = 6;
/** Drop any candidate line longer than this — chips must stay short. */
const MAX_LINE_CHARS = 100;
/** Below this many usable lines, return nothing so the UI falls back to its
 * plain empty state instead of showing a single lonely (or garbage) chip. */
const MIN_USABLE_LINES = 2;

/**
 * Generate a one-shot set of chat suggestions: assemble the same compact,
 * data-only context the briefing uses, then run a single provider completion
 * with the system prompt from `config.suggestions.prompt`. Honors
 * `config.suggestions.count` (capped) and `config.suggestions.model` as a model
 * override against the active provider.
 *
 * The model is asked for one prompt per line; we parse robustly (stripping
 * bullets/numbering/quotes a model may add) and return an empty array rather
 * than garbage if fewer than {@link MIN_USABLE_LINES} usable lines survive.
 */
export async function generateSuggestions(
  runtime: SuggestionsRuntime,
  opts: GenerateSuggestionsOptions = {},
): Promise<Suggestions> {
  const config = runtime.getConfig();
  const suggestionsCfg = config.suggestions ?? {};
  const windowHours = opts.windowHours ?? 24;
  const systemPrompt = suggestionsCfg.prompt?.trim() || DEFAULT_SUGGESTIONS_PROMPT;
  const model = suggestionsCfg.model?.trim() || runtime.getModel();
  const count = clampCount(suggestionsCfg.count);

  const context = assembleSuggestionsContext(runtime, windowHours, count);

  const response = await runtime.getProvider().chat({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: context },
    ],
    temperature: 0.3,
    maxTokens: suggestionsCfg.maxTokens ?? 512,
  });

  return {
    suggestions: parseSuggestions(response.content ?? "", count),
    generatedAt: Date.now(),
  };
}

/**
 * The user-message context for suggestion generation. Reuses the briefing's
 * data-only assembly, then prefixes a one-line instruction reminding the model
 * how many prompts to produce (the count is config-driven, so it can't live in
 * the static system prompt).
 */
export function assembleSuggestionsContext(runtime: SuggestionsRuntime, windowHours: number, count: number): string {
  const data = assembleBriefingContext(runtime, windowHours);
  return `Generate ${count} suggestions based on the current state below.\n\n${data}`;
}

/**
 * Turn a raw model completion into clean chip text. For each line we strip
 * leading bullets (`-`, `*`, `•`), numbering (`1.`, `2)`), and wrapping quotes,
 * then trim. Empty lines and lines over {@link MAX_LINE_CHARS} are dropped, the
 * list is de-duplicated and capped at `count`. If fewer than
 * {@link MIN_USABLE_LINES} usable lines remain we return `[]` so the UI shows
 * its plain empty state rather than a degenerate chip row.
 */
export function parseSuggestions(raw: string, count: number): string[] {
  const cap = clampCount(count);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const rawLine of raw.split("\n")) {
    const line = cleanLine(rawLine);
    if (!line) continue;
    if (line.length > MAX_LINE_CHARS) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= cap) break;
  }

  if (out.length < MIN_USABLE_LINES) return [];
  return out;
}

/** Strip a single line's leading bullet/number marker and wrapping quotes. */
function cleanLine(rawLine: string): string {
  let line = rawLine.trim();
  // Leading bullet markers: -, *, • (optionally repeated/spaced).
  line = line.replace(/^[-*•]+\s*/, "");
  // Leading numbering: "1.", "2)", "3 -", etc.
  line = line.replace(/^\d+[.)\]]\s*/, "");
  line = line.trim();
  // Wrapping quotes (straight or curly), single or double.
  line = stripWrappingQuotes(line);
  return line.trim();
}

function stripWrappingQuotes(s: string): string {
  const pairs: [string, string][] = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
  ];
  for (const [open, close] of pairs) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(1, -1).trim();
    }
  }
  return s;
}

function clampCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) return DEFAULT_COUNT;
  return Math.max(1, Math.min(MAX_COUNT, Math.floor(count)));
}

/** Default number of suggestions when config omits `suggestions.count`. */
const DEFAULT_COUNT = 4;

/** Default suggestions system prompt. Generic, concise, local-model friendly. */
export const DEFAULT_SUGGESTIONS_PROMPT =
  "You are the user's personal assistant. From the state below, write short prompts the user could send you " +
  "right now to make progress. Output one prompt per line, each an imperative or a question under 60 characters. " +
  "No numbering, no bullets, no quotes, no extra text. If nothing stands out, write generally useful prompts.";
