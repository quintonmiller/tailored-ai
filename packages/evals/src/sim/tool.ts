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
      // so a model passing the correct type for a numeric argument was refused
      // before `execute` ever ran, and because the rejection happens inside the
      // loop rather than in the tool, **no `call` event reached the trace at
      // all**. The instrument reads as unused and the metric it feeds stays at
      // zero, which is indistinguishable from a team that never tried.
      //
      // A union widens what is accepted and narrows nothing: every handler here
      // already goes through `String(...)` or `num(...)`.
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

/**
 * Mark some of a tool's parameters as genuinely optional.
 *
 * `tool()` makes every declared parameter required, which is right for an
 * instrument where all the arguments matter and wrong for one whose arguments
 * describe a window or a partial update. Saying "Optional" in the description
 * and `required` in the schema is worse than either alone: core validates
 * against the schema and refuses the call *before* `execute` runs, so a model
 * that read the description and did the correct thing gets a refusal with **no
 * `call` event in the trace at all** — the same shape as the string/number bug
 * above, from the other direction. The instrument reads as unused and the
 * metric it feeds stays at zero, which is indistinguishable from a team that
 * never tried.
 *
 * Post-processing rather than a flag on `tool()` because most tools want the
 * strict behaviour and the exceptions should have to say so.
 */
export function optional(built: Tool, ...keys: string[]): Tool {
  return {
    ...built,
    parameters: {
      ...built.parameters,
      required: ((built.parameters.required as string[]) ?? []).filter((key) => !keys.includes(key)),
    },
  };
}

/** `num(args.chamber, 0)` — models pass strings for everything. */
export function num(value: unknown, fallback: number): number {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}
