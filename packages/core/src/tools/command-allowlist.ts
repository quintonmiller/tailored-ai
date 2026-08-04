/**
 * Allowlist validation for the exec tool that permits *safe* compound shell
 * commands instead of rejecting any command that contains a shell operator.
 *
 * Why: when an allowlist is active the old check rejected the whole command if
 * it contained any of `; | & \` $ ( ) { } < > ! #`. In practice that blocked
 * the single most common thing a coding agent wants to do — chain steps, e.g.
 * `cd pkg && pnpm build && pnpm test` or `cat x | grep y` — forcing it to
 * burn tool rounds re-issuing one command at a time (often thousands of failed
 * calls in autonomous runs).
 *
 * The allowlist's real job is to constrain *which binaries run in command
 * position*. This validator preserves that guarantee while allowing chaining:
 *
 *   - Allowed: chaining with `&&`, `||`, `;`, piping with `|`, and
 *     redirections (`>`, `>>`, `<`, `2>&1`, `&>`). Every command-position
 *     token — the first word of the string and the first word after each
 *     operator — must be in the allowlist.
 *   - Rejected outright (each can run a command whose name the allowlist
 *     can't see, defeating it): command substitution `$(…)` and backticks,
 *     process substitution `<(…)` / `>(…)`, subshell grouping `(…)`,
 *     background `&`, and embedded newlines.
 *
 * Quoting and backslash escaping are honored, so a `(` or `;` inside `"…"`,
 * `'…'`, or written `\(` is treated as literal data, not an operator. This is
 * a guardrail, not a sandbox — like the previous behavior it does not inspect
 * arguments to allowed wrappers (`find -exec`, `xargs`); filesystem isolation
 * is the sandbox's responsibility.
 */

export interface AllowlistCheck {
  ok: boolean;
  /** Present (and human/model-actionable) when `ok` is false. */
  error?: string;
}

/**
 * Which commands may run in command position. The same shape is read from
 * `tools.exec` (deployment-wide) and from `agents.<name>.exec` (that agent
 * only), so there is one thing to learn and one implementation to trust.
 *
 * - `allow` — omitted or empty means **no restriction**, which is the historical
 *   behaviour of an absent allowlist. Listing anything makes it exhaustive.
 * - `deny` — always wins over `allow`, at both levels. A deny at the deployment
 *   level cannot be undone by an agent.
 *
 * Entries are literal command names or glob patterns: `*` matches any run of
 * characters, `?` matches one. Matching is against the command name only
 * (`ntn`, `git`), never the arguments — `git *` will not do what it looks like.
 */
export interface CommandRules {
  allow?: string[];
  deny?: string[];
}

/** Compile one entry to a matcher. Literal names are the common case. */
function toMatcher(pattern: string): (name: string) => boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return (name) => name === pattern;
  }
  const rx = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  return (name) => rx.test(name);
}

function matchesAny(name: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return false;
  return patterns.some((p) => toMatcher(p)(name));
}

/**
 * How an agent's rules combine with the deployment's.
 *
 * - `intersect` (default) — an agent may only narrow. A command must satisfy
 *   both levels, and denies from both apply. This is the safe direction: a typo
 *   in one agent's block cannot grant something the deployment never sanctioned.
 * - `override` — the agent's rules replace the deployment's outright, including
 *   its denies. Useful when one agent legitimately needs a tool nobody else
 *   should have, and a foot-gun otherwise.
 *
 * Deployment-level only, deliberately: if an agent could choose `override` for
 * itself, `intersect` would guarantee nothing.
 */
export type CommandRulesMode = "intersect" | "override";

/**
 * Rules after merging, where `allow` carries one more distinction than the
 * config shape does:
 *
 * - `undefined` — unrestricted, nothing to check against
 * - `[]`        — **nothing** may run. Only reachable by intersecting two
 *                 disjoint allow lists, and it must not collapse back into
 *                 "unrestricted", which is the direction that fails open.
 */
export interface EffectiveCommandRules {
  allow?: string[];
  deny: string[];
}

/** An omitted or empty `allow` in config means unrestricted; normalize to undefined. */
function normalize(rules: CommandRules | undefined): EffectiveCommandRules {
  return { allow: rules?.allow?.length ? rules.allow : undefined, deny: rules?.deny ?? [] };
}

/**
 * Combine deployment and agent rules into the single set to enforce.
 *
 * Intersecting two allow lists keeps the agent entries the deployment also
 * permits. A pattern is intersected by testing its literal text against the
 * other side, so `git*` under a deployment allowing only `git` is dropped
 * rather than expanded — conservative by design, since this is a security
 * control and the failure worth avoiding is the permissive one.
 */
export function mergeCommandRules(
  deployment: CommandRules | undefined,
  agent: CommandRules | undefined,
  mode: CommandRulesMode = "intersect",
): EffectiveCommandRules {
  const dep = normalize(deployment);
  const ag = normalize(agent);

  if (!ag.allow && ag.deny.length === 0) return dep;
  if (mode === "override") return ag;

  let allow: string[] | undefined;
  if (!dep.allow) allow = ag.allow;
  else if (!ag.allow) allow = dep.allow;
  else allow = ag.allow.filter((a) => matchesAny(a, dep.allow));

  return { allow, deny: [...dep.deny, ...ag.deny] };
}

/**
 * Validate `command` against merged rules, permitting safe compound commands.
 * `deny` is checked first and wins; see the module docstring for the policy on
 * operators, quoting and substitution.
 */
export function checkCommandRules(command: string, rules: EffectiveCommandRules | undefined): AllowlistCheck {
  if (!rules || (!rules.allow && rules.deny.length === 0)) return { ok: true };

  const split = splitSegments(command);
  if ("ok" in split) return split; // a rejection

  for (const seg of split.segments) {
    const head = extractHead(seg);
    if (head === null) continue;

    if (matchesAny(head, rules.deny)) {
      return { ok: false, error: `Command "${head}" is blocked: ${rules.deny.join(", ")}` };
    }
    if (rules.allow && !matchesAny(head, rules.allow)) {
      return {
        ok: false,
        error: rules.allow.length
          ? `Command "${head}" is not in the allowlist: ${rules.allow.join(", ")}`
          : `Command "${head}" is not permitted — this agent's exec rules allow nothing.`,
      };
    }
  }
  return { ok: true };
}

/** Reject reasons phrased to teach a local model what to do instead. */
function reject(reason: string): AllowlistCheck {
  return { ok: false, error: `Command rejected: ${reason}` };
}

/**
 * Split a command into operator-delimited segments while honoring quotes and
 * escapes, rejecting the constructs that could smuggle an unlisted command.
 */
function splitSegments(command: string): { segments: string[] } | AllowlistCheck {
  const segments: string[] = [];
  let segStart = 0;
  let quote: '"' | "'" | null = null;
  const n = command.length;
  let i = 0;

  while (i < n) {
    const c = command[i];

    if (quote) {
      // Inside quotes only the matching close quote is special (plus a
      // backslash escape inside double quotes). Everything else is data.
      if (quote === '"' && c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (c === "\\") {
      // Escaped next char is literal (e.g. `\;` in `find … -exec … {} \;`).
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "\n" || c === "\r") {
      return reject("newlines are not allowed when an allowlist is active — issue one command per call");
    }
    if (c === "`") {
      return reject("backtick command substitution is not allowed when an allowlist is active");
    }
    if (c === "(") {
      // Covers subshell `(…)`, command substitution `$(…)`, and process
      // substitution `<(…)` / `>(…)` — all reach `(` here when unquoted.
      return reject("command substitution / subshells '(' are not allowed when an allowlist is active");
    }
    if (c === "&") {
      const next = command[i + 1];
      const prev = command[i - 1];
      if (next === "&") {
        segments.push(command.slice(segStart, i));
        i += 2;
        segStart = i;
        continue;
      }
      // `&>` and `>&` are redirections, not backgrounding — leave them in the
      // current segment. A standalone `&` backgrounds a process: reject it.
      if (next === ">" || prev === ">") {
        i += 1;
        continue;
      }
      return reject("background '&' is not allowed when an allowlist is active");
    }
    if (c === "|") {
      segments.push(command.slice(segStart, i));
      i += command[i + 1] === "|" ? 2 : 1;
      segStart = i;
      continue;
    }
    if (c === ";") {
      segments.push(command.slice(segStart, i));
      i += 1;
      segStart = i;
      continue;
    }
    i += 1;
  }

  if (quote) return reject("unterminated quote");
  segments.push(command.slice(segStart));
  return { segments };
}

/** Quote/escape-aware whitespace tokenizer; returns tokens with quotes removed. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (quote === '"' && c === "\\") {
        cur += segment[i + 1] ?? "";
        i += 1;
        started = true;
        continue;
      }
      if (c === quote) {
        quote = null;
        started = true;
        continue;
      }
      cur += c;
      started = true;
      continue;
    }
    if (c === "\\") {
      cur += segment[i + 1] ?? "";
      i += 1;
      started = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

/**
 * The command name in a segment: the first token after any leading
 * `VAR=value` assignments and leading redirections. Returns null for an empty
 * segment (e.g. a trailing `&&`).
 */
function extractHead(segment: string): string | null {
  const tokens = tokenize(segment.trim());
  let idx = 0;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      idx += 1; // env assignment prefix
      continue;
    }
    if (/^\d*[<>]+$/.test(t)) {
      idx += 2; // bare redirect operator + its target token
      continue;
    }
    if (/^\d*[<>]/.test(t)) {
      idx += 1; // glued redirect, e.g. `>out.log`, `2>&1`
      continue;
    }
    return t;
  }
  return null;
}

/**
 * Validate `command` against a plain list of permitted command names.
 * Retained for callers that predate {@link CommandRules}; equivalent to
 * `checkCommandRules(command, { allow, deny: [] })`.
 */
export function checkCommandAllowlist(command: string, allowed: string[]): AllowlistCheck {
  return checkCommandRules(command, { allow: allowed.length ? allowed : undefined, deny: [] });
}
