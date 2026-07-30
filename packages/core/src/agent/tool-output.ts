import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Bound how much of a tool's output reaches the conversation.
 *
 * Nothing capped tool results before this. Tool *descriptions* were truncated
 * at 300 chars for local-model compatibility; results — the part that actually
 * grows — were unbounded, and arrive from third-party servers whose response
 * size is not ours to choose.
 *
 * What that cost, measured: one `mcp_notion_API-post-search` with `page_size:
 * 50` returned 70,485 chars / 27,187 real tokens against an 18,800-token
 * history budget. `trimHistory` then evicted from the front until it fit,
 * which meant evicting the user's question; `ensureUserMessagePresent` spliced
 * the *first* user message back in, so the agent answered a welcome message
 * from an hour earlier and introduced itself. Three times in forty minutes.
 *
 * The failure reads as an agent with amnesia, never as an agent with a big
 * tool result. `loop.ts` already says this about the `<context>` block — "the
 * symptom is an agent that forgets rather than an agent with a big prompt" —
 * and guards the system-prompt side of the budget. This is the same hole on
 * the history side, where it is worse: per-turn, unbounded, and remote.
 */

/**
 * ~8,000 estimated tokens. Larger than nearly any single legitimate result,
 * small enough that no one call can dominate a history budget. Tunable
 * globally via `agent.maxToolOutputChars` and per tool via
 * `tools.<id>.maxOutputChars`; `0` disables capping.
 */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 32_000;

/** Head keeps more than tail: for JSON the leading object carries the ids and shape worth acting on. */
const HEAD_SHARE = 0.7;

export interface CapToolOutputOptions {
  /** Tool that produced the output — named in the marker so the agent knows which call to narrow. */
  toolName: string;
  /** Chars to keep. `<= 0` disables capping entirely. */
  limit: number;
  sessionId?: string;
  /** Overrides the default scratch location. Full output is written here before truncation. */
  scratchDir?: string;
}

function scratchRoot(override: string | undefined, sessionId: string | undefined): string {
  const base = override ?? (process.env.TAI_HOME ? join(process.env.TAI_HOME, "tool-outputs") : undefined);
  return join(resolve(base ?? join(homedir(), ".tai", "tool-outputs")), sessionId || "unknown");
}

/**
 * Persist the full output under a content-addressed name.
 *
 * Named by hash rather than timestamp on purpose. The loop's stuck-model
 * detector compares consecutive tool results verbatim, so a marker carrying a
 * unique path would make two identical results compare unequal and quietly
 * disable that guard — which is exactly the guard that catches a model
 * re-issuing the call that got truncated. `exec`'s existing truncation names
 * its file by timestamp and has this bug; it is not inherited here. Hashing
 * also dedupes: the same payload written twice is one file.
 */
async function persistFullOutput(raw: string, opts: CapToolOutputOptions): Promise<string> {
  const dir = scratchRoot(opts.scratchDir, opts.sessionId);
  await mkdir(dir, { recursive: true });
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const path = join(dir, `${opts.toolName}-${digest}.txt`);
  await writeFile(path, raw, "utf8");
  return path;
}

/**
 * Return `raw` unchanged when it fits, otherwise a head+tail summary carrying
 * a pointer to the full output.
 *
 * Deterministic for a given input: same output, same marker, same file name.
 * The repeat detector depends on that.
 */
export async function capToolOutput(raw: string, opts: CapToolOutputOptions): Promise<string> {
  if (opts.limit <= 0 || raw.length <= opts.limit) return raw;

  // Best-effort persistence. A failure here (read-only disk, no HOME on a CI
  // runner) must still yield a truncated result — returning the full string
  // would reinstate the very blowup this exists to prevent.
  let reference: string;
  try {
    reference = `Full output: ${await persistFullOutput(raw, opts)}`;
  } catch (err) {
    reference = `Full output could not be saved (${(err as Error).message}), so the omitted part is gone.`;
  }

  const headChars = Math.floor(opts.limit * HEAD_SHARE);
  const tailChars = opts.limit - headChars;
  const omitted = raw.length - opts.limit;

  return [
    `[${opts.toolName} returned ${raw.length.toLocaleString()} chars — truncated to ${opts.limit.toLocaleString()}. ${reference}`,
    // Said explicitly because the obvious move for a model that got a partial
    // answer is to run the same call again, which returns this same string.
    `Repeating this call returns the same truncated result. To see more, narrow the request — fewer results, a filter, a smaller page size — or read the file above.]`,
    raw.slice(0, headChars),
    `... [${omitted.toLocaleString()} chars omitted] ...`,
    raw.slice(-tailChars),
  ].join("\n");
}

/**
 * Chars allowed for one tool, most specific first: a per-tool
 * `tools.<id>.maxOutputChars`, else the global `agent.maxToolOutputChars`.
 *
 * MCP tools are not keyed in `tools:` by discovery — they arrive as
 * `mcp_<server>_<tool>`. Because the lookup is by resolved tool name and
 * `tools:` is an open map, naming one there works anyway:
 *
 * ```yaml
 * tools:
 *   mcp_notion_API-post-search:
 *     maxOutputChars: 8000
 * ```
 */
export function resolveToolOutputLimit(
  toolName: string,
  perTool: Record<string, number> | undefined,
  globalLimit: number | undefined,
): number {
  const specific = perTool?.[toolName];
  if (typeof specific === "number") return specific;
  return globalLimit ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
}
