import { resolveString, type Scope } from "./scope.js";

/**
 * Evaluate a boolean expression against a workflow scope. Grammar:
 *
 *   expr   := or
 *   or     := and ('||' and)*
 *   and    := not ('&&' not)*
 *   not    := '!' not | cmp
 *   cmp    := atom (('==' | '!=' | '>=' | '<=' | '>' | '<') atom)?
 *   atom   := '(' expr ')' | literal | ${path}
 *   literal := number | quoted-string | true | false | null
 *
 * Variable lookups (`${...}`) are resolved against the scope. Undefined
 * paths come back as `null`. Comparisons coerce loosely (numeric when
 * both sides parse as numbers, else string).
 *
 * No method calls, no arbitrary JS — anything outside the grammar is a
 * parse error.
 */

type Token =
  | { kind: "lparen" }
  | { kind: "rparen" }
  | { kind: "and" }
  | { kind: "or" }
  | { kind: "not" }
  | { kind: "op"; value: "==" | "!=" | ">=" | "<=" | ">" | "<" }
  | { kind: "value"; value: unknown };

export function evaluateExpression(expr: string, scope: Scope): boolean {
  const tokens = tokenize(expr, scope);
  const parser = { tokens, pos: 0 };
  const result = parseOr(parser);
  if (parser.pos !== tokens.length) {
    throw new Error(`unexpected token at position ${parser.pos} in: ${expr}`);
  }
  return Boolean(result);
}

function tokenize(input: string, scope: Scope): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(") {
      tokens.push({ kind: "lparen" });
      i++;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen" });
      i++;
      continue;
    }
    if (c === "&" && input[i + 1] === "&") {
      tokens.push({ kind: "and" });
      i += 2;
      continue;
    }
    if (c === "|" && input[i + 1] === "|") {
      tokens.push({ kind: "or" });
      i += 2;
      continue;
    }
    if (c === "=" && input[i + 1] === "=") {
      tokens.push({ kind: "op", value: "==" });
      i += 2;
      continue;
    }
    if (c === "!" && input[i + 1] === "=") {
      tokens.push({ kind: "op", value: "!=" });
      i += 2;
      continue;
    }
    if (c === ">" && input[i + 1] === "=") {
      tokens.push({ kind: "op", value: ">=" });
      i += 2;
      continue;
    }
    if (c === "<" && input[i + 1] === "=") {
      tokens.push({ kind: "op", value: "<=" });
      i += 2;
      continue;
    }
    if (c === "!") {
      tokens.push({ kind: "not" });
      i++;
      continue;
    }
    if (c === ">") {
      tokens.push({ kind: "op", value: ">" });
      i++;
      continue;
    }
    if (c === "<") {
      tokens.push({ kind: "op", value: "<" });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const close = input.indexOf(c, i + 1);
      if (close === -1) throw new Error(`unterminated string in expression`);
      tokens.push({ kind: "value", value: input.slice(i + 1, close) });
      i = close + 1;
      continue;
    }
    if (c === "$" && input[i + 1] === "{") {
      const close = input.indexOf("}", i + 2);
      if (close === -1) throw new Error(`unterminated \${...} in expression`);
      const ref = input.slice(i, close + 1);
      const value = resolveString(ref, scope);
      // Normalize missing references to null so `${missing} == null` works.
      const normalized = value === undefined || value === "" ? null : value;
      tokens.push({ kind: "value", value: normalized });
      i = close + 1;
      continue;
    }
    // numeric or identifier literal
    let j = i;
    while (j < input.length && /[A-Za-z0-9_.\-+]/.test(input[j])) j++;
    if (j === i) throw new Error(`unexpected character "${c}" in expression`);
    const lit = input.slice(i, j);
    if (lit === "true") tokens.push({ kind: "value", value: true });
    else if (lit === "false") tokens.push({ kind: "value", value: false });
    else if (lit === "null") tokens.push({ kind: "value", value: null });
    else if (/^-?\d+(\.\d+)?$/.test(lit)) tokens.push({ kind: "value", value: Number(lit) });
    else tokens.push({ kind: "value", value: lit });
    i = j;
  }
  return tokens;
}

interface Parser {
  tokens: Token[];
  pos: number;
}

function peek(p: Parser): Token | undefined {
  return p.tokens[p.pos];
}

function consume(p: Parser): Token | undefined {
  return p.tokens[p.pos++];
}

function parseOr(p: Parser): unknown {
  let left = parseAnd(p);
  while (peek(p)?.kind === "or") {
    consume(p);
    const right = parseAnd(p);
    left = Boolean(left) || Boolean(right);
  }
  return left;
}

function parseAnd(p: Parser): unknown {
  let left = parseNot(p);
  while (peek(p)?.kind === "and") {
    consume(p);
    const right = parseNot(p);
    left = Boolean(left) && Boolean(right);
  }
  return left;
}

function parseNot(p: Parser): unknown {
  if (peek(p)?.kind === "not") {
    consume(p);
    return !parseNot(p);
  }
  return parseCmp(p);
}

function parseCmp(p: Parser): unknown {
  const left = parseAtom(p);
  const next = peek(p);
  if (next?.kind === "op") {
    consume(p);
    const right = parseAtom(p);
    return compare(next.value, left, right);
  }
  return left;
}

function parseAtom(p: Parser): unknown {
  const tok = consume(p);
  if (!tok) throw new Error("unexpected end of expression");
  if (tok.kind === "lparen") {
    const inner = parseOr(p);
    const close = consume(p);
    if (close?.kind !== "rparen") throw new Error("missing closing paren");
    return inner;
  }
  if (tok.kind === "value") return tok.value;
  if (tok.kind === "not") {
    return !parseAtom(p);
  }
  throw new Error(`unexpected token ${tok.kind}`);
}

function compare(op: "==" | "!=" | ">=" | "<=" | ">" | "<", a: unknown, b: unknown): boolean {
  if (op === "==") return looseEq(a, b);
  if (op === "!=") return !looseEq(a, b);
  const na = toNumber(a);
  const nb = toNumber(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) {
    const sa = String(a ?? "");
    const sb = String(b ?? "");
    if (op === ">") return sa > sb;
    if (op === "<") return sa < sb;
    if (op === ">=") return sa >= sb;
    if (op === "<=") return sa <= sb;
  }
  if (op === ">") return na > nb;
  if (op === "<") return na < nb;
  if (op === ">=") return na >= nb;
  if (op === "<=") return na <= nb;
  return false;
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a) === String(b);
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return Number.NaN;
}
