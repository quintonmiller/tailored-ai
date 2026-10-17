/**
 * Running an agent's guardrails against one outgoing message.
 *
 * Call sites hand in the resolved specs and get back either nothing or the
 * first failure's reason, ready to be given to the agent as a correction.
 */
import { guardrailRegistry } from "./registry.js";
import type { Guardrail, GuardrailContext, GuardrailSpec } from "./types.js";

/**
 * Built guardrails, keyed by the spec that made them.
 *
 * Every message would otherwise recompile every pattern in every rule. The key
 * is the spec's own JSON, so a config reload that changes a rule builds a new
 * entry and a reload that changes nothing reuses the old one.
 */
const cache = new Map<string, Guardrail | null>();

/** Ids already complained about, so an unregistered guardrail warns once. */
const warned = new Set<string>();

function build(spec: GuardrailSpec): Guardrail | null {
  const key = JSON.stringify(spec);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const factory = guardrailRegistry.get(spec.use);
  let made: Guardrail | null = null;
  if (!factory) {
    if (!warned.has(spec.use)) {
      warned.add(spec.use);
      console.warn(
        `[guardrail] No guardrail registered as "${spec.use}" — it is declared in config and nothing is checking it. ` +
          `Registered: ${guardrailRegistry.list().join(", ") || "none"}`,
      );
    }
  } else {
    try {
      made = factory(spec.options ?? {});
    } catch (err) {
      console.warn(`[guardrail] "${spec.use}" failed to build: ${(err as Error).message}`);
    }
  }
  cache.set(key, made);
  return made;
}

/**
 * The reason the first failing guardrail gives, or undefined if the message
 * passes — including when there are no guardrails at all.
 *
 * **Fails open.** A guardrail that throws is reported and skipped, and the
 * message goes out. The alternative is an agent silenced indefinitely by a bug
 * in a quality check, which is a much worse failure than the drift the check
 * was watching for: a room that has gone quiet gives nobody a reason to
 * suspect a regex. This is the opposite of the hooks decision, deliberately —
 * a `beforeRun` hook supplies data the prompt then claims to have, so running
 * without it produces confident fiction. Nothing downstream of here depends on
 * a guardrail having run.
 */
export async function checkGuardrails(
  specs: GuardrailSpec[] | undefined,
  text: string,
  ctx: GuardrailContext,
): Promise<string | undefined> {
  if (!specs?.length) return undefined;
  for (const spec of specs) {
    if (spec.surfaces?.length && !spec.surfaces.includes(ctx.surface)) continue;
    const guard = build(spec);
    if (!guard) continue;
    try {
      const verdict = await guard.check(text, ctx);
      if (!verdict.ok) return verdict.reason;
    } catch (err) {
      console.warn(
        `[guardrail] "${spec.use}" threw while checking a message from ${ctx.agent}: ${(err as Error).message}`,
      );
    }
  }
  return undefined;
}

/** Test seam: drop the built-guardrail cache. */
export function resetGuardrailCache(): void {
  cache.clear();
  warned.clear();
}
