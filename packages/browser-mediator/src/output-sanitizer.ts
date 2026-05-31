/**
 * Output sanitiser — belt-and-suspenders regex pass on text leaving the
 * mediator. Replaces sensitive substrings with `[REDACTED-TYPE]` so the
 * agent never sees raw PANs, SSNs, etc. extracted from a page.
 *
 * The pattern set is intentionally narrow. Each pattern has an optional
 * `validate` callback so e.g. PAN matches only fire when Luhn passes.
 */

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export interface SanitizerPattern {
  regex: RegExp;
  type: string;
  validate?: (match: string) => boolean;
}

export const DEFAULT_SANITIZER_PATTERNS: SanitizerPattern[] = [
  { regex: /\b(\d{13,19})\b/g, type: "PAN", validate: (m) => luhnCheck(m) },
  { regex: /\b(\d{3}-\d{2}-\d{4})\b/g, type: "SSN" },
  { regex: /\b([A-Z]{2}\d{2}[A-Z0-9]{4,30})\b/gi, type: "IBAN" },
  { regex: /(?<!\d)\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g, type: "PHONE" },
  { regex: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, type: "EMAIL" },
  {
    regex: /\b(\d{1,6}\s+[A-Za-z]+\s+(?:St|Ave|Blvd|Dr|Rd|Ln|Way|Ct|Pl)[.,]?\s*(?:[A-Za-z]{2}\s+\d{5})?)\b/gi,
    type: "ADDRESS",
  },
];

/** Replace sensitive patterns in `text` with `[REDACTED-TYPE]`. */
export function sanitizeOutput(text: string, patterns: SanitizerPattern[] = DEFAULT_SANITIZER_PATTERNS): string {
  let result = text;
  for (const { regex, type, validate } of patterns) {
    const re = new RegExp(regex.source, regex.flags);
    result = result.replace(re, (m) => (validate && !validate(m) ? m : `[REDACTED-${type}]`));
  }
  return result;
}
