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
 * Validate `command` against `allowed` (a list of permitted command names),
 * permitting safe compound commands. See the module docstring for the policy.
 */
export function checkCommandAllowlist(command: string, allowed: string[]): AllowlistCheck {
  const split = splitSegments(command);
  if ("ok" in split) return split; // a rejection
  for (const seg of split.segments) {
    const head = extractHead(seg);
    if (head === null) continue;
    if (!allowed.includes(head)) {
      return {
        ok: false,
        error: `Command "${head}" is not in the allowlist: ${allowed.join(", ")}`,
      };
    }
  }
  return { ok: true };
}
