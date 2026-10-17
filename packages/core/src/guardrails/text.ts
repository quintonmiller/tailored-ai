/**
 * The one guardrail core ships: mechanical checks on the text itself.
 *
 * Deliberately domain-free — length, patterns that must not appear, patterns
 * that may appear only so often. Everything specific to a deployment lives in
 * that deployment's own options, and anything needing judgement rather than
 * counting belongs in a plugin that can afford a model call.
 *
 * `when` is what makes the length caps usable. A blanket "never write more
 * than 700 characters" is nearly always wrong — the same agent legitimately
 * writes long and short messages — but "when you are reporting a die roll,
 * never write more than 400" is a rule that only bites the case it is about.
 */
import type { Guardrail, GuardrailFactory, GuardrailVerdict } from "./types.js";

interface TextOptions {
  /** Only run the checks below when the body matches this pattern. */
  when?: string;
  maxChars?: number;
  maxWords?: number;
  /** Any match fails. */
  deny?: string[];
  /** At most `max` matches of `pattern`. */
  limit?: { pattern: string; max: number }[];
  /** Appended to whichever reason fires, for house-specific guidance. */
  message?: string;
  /** Case-sensitive matching. Default false. */
  caseSensitive?: boolean;
}

/**
 * A bad pattern must not fail the message.
 *
 * A guardrail that throws on its own config would reject every message the
 * agent writes, forever, with an error about a regex — which is a far worse
 * outcome than the drift it was added to prevent. So a pattern that will not
 * compile is reported once and skipped.
 */
function compile(source: string, flags: string, where: string): RegExp | null {
  try {
    return new RegExp(source, flags);
  } catch (err) {
    console.warn(`[guardrail] text: ignoring ${where} pattern ${JSON.stringify(source)} — ${(err as Error).message}`);
    return null;
  }
}

const factory: GuardrailFactory = (raw): Guardrail => {
  const o = raw as TextOptions;
  const flags = o.caseSensitive ? "g" : "gi";
  const testFlags = o.caseSensitive ? "" : "i";
  const when = o.when ? compile(o.when, testFlags, "when") : null;
  const deny = (o.deny ?? []).map((p) => ({ source: p, re: compile(p, testFlags, "deny") }));
  const limit = (o.limit ?? []).map((l) => ({ ...l, re: compile(l.pattern, flags, "limit") }));
  const tail = o.message ? ` ${o.message}` : "";

  return {
    id: "text",
    check(text): GuardrailVerdict {
      const body = text.trim();
      if (!body) return { ok: true };
      // `when` did not match, so none of this rule is about this message.
      if (when && !when.test(body)) return { ok: true };

      if (o.maxChars !== undefined && body.length > o.maxChars) {
        return {
          ok: false,
          reason: `That message was ${body.length} characters and the limit here is ${o.maxChars}. Say the same thing shorter — cut the explanation, keep the action.${tail}`,
        };
      }
      const words = body.split(/\s+/).filter(Boolean).length;
      if (o.maxWords !== undefined && words > o.maxWords) {
        return {
          ok: false,
          reason: `That message was ${words} words and the limit here is ${o.maxWords}. Say the same thing shorter.${tail}`,
        };
      }
      for (const d of deny) {
        if (d.re?.test(body)) {
          return {
            ok: false,
            reason: `That message matched something this agent is not supposed to write: ${d.source}.${tail}`,
          };
        }
      }
      for (const l of limit) {
        if (!l.re) continue;
        // A /g regex carries lastIndex between calls, so it must be reset or
        // the second message checked against the same rule starts matching
        // from wherever the first one stopped and the count is wrong.
        l.re.lastIndex = 0;
        const n = (body.match(l.re) ?? []).length;
        if (n > l.max) {
          return {
            ok: false,
            reason: `That message used ${JSON.stringify(l.pattern)} ${n} times and the limit is ${l.max}. Rewrite it without them.${tail}`,
          };
        }
      }
      return { ok: true };
    },
  };
};

export default factory;
