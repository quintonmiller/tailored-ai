/**
 * Declaring an instrument a simulation hands to one role.
 *
 * Lifted out of the factory when the second simulation needed the same thing.
 * It is not a seam and nothing outside `sim/` should reach for it — a
 * simulation's tools are its own business, and this is only here so two of them
 * do not each carry a copy of the same twenty lines.
 *
 * `num` is deliberately *not* shared with the factory, which keeps its own:
 * that one parses with `parseFloat` and falls back to `NaN`, and quietly
 * changing how a live baseline reads its arguments to save four lines is a bad
 * trade.
 */

import type { Tool } from "@tailored-ai/core";

export function tool(
  name: string,
  description: string,
  params: Record<string, string>,
  execute: (args: Record<string, unknown>) => string,
  effect: "read" | "write" = "write",
): Tool {
  return {
    name,
    description,
    parameters: {
      type: "object",
      // `["string", "number"]`, not `"string"`, and it is not cosmetic.
      //
      // Every parameter here was declared a string because `num()` exists to
      // cope with models that "pass strings for everything". The schema then
      // told core's `validateToolArgs` to *reject* the number form outright —
      // so a model that passed the correct type for `amount` got
      // `Parameter "amount" should be a number, got number`-shaped refusals
      // before `execute` ever ran, and because the rejection happens inside the
      // loop rather than the tool, **no `call` event reached the trace at all**.
      //
      // Measured live on 2026-08-18. A cleric spent three rounds of a paid run
      // publicly apologising to the party for "false claims" about gold
      // transfers it believed it had made, concluded from the repeated silence
      // that *"give_gold doesn't exist in my tool list"*, and was eventually
      // told by another character that the amount had to be a string. Both
      // successful transfers in the whole run passed `"66"` and `"25 gold"`.
      // The tool would have accepted either — `num()` strips non-digits — and
      // the only thing standing in the way was this word.
      //
      // A union widens what is accepted and narrows nothing: every handler
      // already goes through `String(...)` or `num(...)`. Verified against the
      // serving model that a union type is accepted in a tool schema.
      properties: Object.fromEntries(
        Object.entries(params).map(([k, d]) => [k, { type: ["string", "number"], description: d }]),
      ),
      required: Object.keys(params),
    },
    effect,
    async execute(args) {
      try {
        return { success: true, output: execute(args) };
      } catch (err) {
        // A refusal is information, not a crash. The agent should read it and
        // choose differently, exactly as it would with a real system — and in a
        // puzzle it is the only way the machinery can teach its own order.
        return { success: true, output: `Refused: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * An instrument whose behaviour depends on who picked it up.
 *
 * The only correct home for a tool several roles share. `sim.tools()` is keyed
 * by role, but the harness flattens every role's list into one registry and the
 * agent's allowlist selects by *name* — so two roles exporting a `raise_paddle`
 * each do not get one each, they get whichever was registered last. Six agents
 * then operate a seventh's machinery and report it accurately, which is
 * indistinguishable from six agents lying.
 *
 * A tool declared here is handed to everybody and reads `context.agentName` to
 * decide what it does, which is both correct and honest: the machinery is
 * public, the hands on it are not.
 */
export function agentTool(
  name: string,
  description: string,
  params: Record<string, string>,
  execute: (args: Record<string, unknown>, agent: string | undefined) => string,
  effect: "read" | "write" = "write",
): Tool {
  const base = tool(name, description, params, () => "", effect);
  return {
    ...base,
    async execute(args, context) {
      try {
        return { success: true, output: execute(args, context?.agentName) };
      } catch (err) {
        return { success: true, output: `Refused: ${(err as Error).message}` };
      }
    },
  };
}

/** `num(args.chamber, 0)` — models pass strings for everything. */
export function num(value: unknown, fallback: number): number {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}
