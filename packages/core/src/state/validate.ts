/**
 * Checking a record against its type's schema.
 *
 * Core validates a deliberate subset of JSON Schema rather than taking on a
 * dependency every self-hosted image would carry: types, enums, required and
 * nested fields, array items, numeric and length bounds, and a pattern. That
 * covers the schemas a deployment writes by hand.
 *
 * Two things matter more than coverage:
 *
 * - **Errors read as corrections.** They go back to a model, often a small
 *   local one, as the reason a write failed. "`status` must be one of: draft,
 *   active, done (got `finished`)" is something it can act on; a JSON pointer
 *   and a keyword name is not.
 * - **Unsupported keywords are reported, not silently passed.** A schema using
 *   `oneOf` would otherwise look enforced and enforce nothing, which is the
 *   "declared but never wired" failure this codebase keeps meeting. Config
 *   validation names them so the gap is visible.
 */
import type { JsonSchema, JsonSchemaType } from "./types.js";

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "pattern",
  // Annotations: carry no rule, so nothing to enforce.
  "description",
  "title",
  "default",
  "examples",
  "$comment",
]);

/** Keywords in `schema` (recursively) that core does not enforce, as `path: keyword`. */
export function unsupportedKeywords(schema: JsonSchema | undefined, path = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const found: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) found.push(path ? `${path}: ${key}` : key);
  }
  if (schema.properties && typeof schema.properties === "object") {
    for (const [name, sub] of Object.entries(schema.properties)) {
      found.push(...unsupportedKeywords(sub, path ? `${path}.${name}` : name));
    }
  }
  if (schema.items && typeof schema.items === "object") {
    found.push(...unsupportedKeywords(schema.items, `${path || "items"}[]`));
  }
  return found;
}

/**
 * Every way `value` fails `schema`, as sentences. Empty when it passes or when
 * there is no schema. `path` names the value in messages; the top level of a
 * record's data is the empty path.
 */
export function validateAgainstSchema(schema: JsonSchema | undefined, value: unknown, path = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  const errors: string[] = [];
  const label = path ? `\`${path}\`` : "the data";

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => matchesType(t, value))) {
      errors.push(`${label} must be ${describeTypes(allowed)} (got ${describeValue(value)})`);
      // Further checks assume the right type and would only add noise.
      return errors;
    }
  }

  if (schema.enum && !schema.enum.some((option) => sameValue(option, value))) {
    errors.push(`${label} must be one of: ${schema.enum.map(formatOption).join(", ")} (got ${describeValue(value)})`);
  }
  if ("const" in schema && !sameValue(schema.const, value)) {
    errors.push(`${label} must be ${formatOption(schema.const)}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${label} must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${label} must be at most ${schema.maxLength} characters (got ${value.length})`);
    }
    if (schema.pattern !== undefined) {
      const re = compilePattern(schema.pattern);
      if (re && !re.test(value)) errors.push(`${label} must match the pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${label} must be at least ${schema.minimum} (got ${value})`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${label} must be at most ${schema.maximum} (got ${value})`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${label} must have at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${label} must have at most ${schema.maxItems} item(s) (got ${value.length})`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validateAgainstSchema(schema.items, item, `${path || "items"}[${i}]`));
      });
    }
  }

  if (isPlainObject(value)) {
    const props = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) errors.push(`\`${join(path, name)}\` is required`);
    }
    for (const [name, sub] of Object.entries(props)) {
      if (value[name] !== undefined) errors.push(...validateAgainstSchema(sub, value[name], join(path, name)));
    }
    if (schema.additionalProperties === false) {
      const known = Object.keys(props);
      for (const name of Object.keys(value)) {
        if (!(name in props)) {
          const fields = known.length ? ` (fields: ${known.join(", ")})` : "";
          errors.push(`\`${join(path, name)}\` is not a field of this type${fields}`);
        }
      }
    }
  }

  return errors;
}

/**
 * One line per field for a model to read: `name (string, required)`,
 * `status (draft | active | done)`. Deliberately not the schema itself, which
 * is long and mostly noise in a prompt.
 */
export function summarizeFields(schema: JsonSchema | undefined): string {
  if (!schema?.properties || Object.keys(schema.properties).length === 0) return "any fields";
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties)
    .map(([name, sub]) => {
      const parts = [describeField(sub)];
      if (required.has(name)) parts.push("required");
      return `${name} (${parts.join(", ")})`;
    })
    .join(", ");
}

function describeField(schema: JsonSchema): string {
  if (schema.enum) return schema.enum.map(formatOption).join(" | ");
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("array") && schema.items) {
    const inner = schema.items.type;
    return inner && !Array.isArray(inner) ? `list of ${inner}s` : "list";
  }
  return types.length ? types.join(" or ") : "any";
}

function matchesType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      // An unknown type name is a schema bug; failing every write would turn it
      // into an agent that can never save anything, so it does not constrain.
      return true;
  }
}

function describeTypes(types: JsonSchemaType[]): string {
  const article: Partial<Record<JsonSchemaType, string>> = {
    integer: "a whole number",
    array: "a list",
    object: "an object",
    null: "null",
  };
  const words = types.map((t) => article[t] ?? `a ${t}`);
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return value.length > 40 ? "a long string" : JSON.stringify(value);
  if (typeof value === "object") return "an object";
  return `${typeof value} ${String(value)}`;
}

function formatOption(option: unknown): string {
  return typeof option === "string" ? option : JSON.stringify(option);
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function join(path: string, name: string): string {
  return path ? `${path}.${name}` : name;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const patternCache = new Map<string, RegExp | null>();

/** A pattern that will not compile constrains nothing, rather than failing every write. */
function compilePattern(source: string): RegExp | null {
  if (!patternCache.has(source)) {
    try {
      patternCache.set(source, new RegExp(source, "u"));
    } catch {
      patternCache.set(source, null);
    }
  }
  return patternCache.get(source) ?? null;
}
