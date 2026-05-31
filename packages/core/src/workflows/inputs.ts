import type { WorkflowInputSchema, WorkflowInputsSchema } from "./types.js";

/**
 * Validate and normalize an inbound input object against a declarative schema.
 * Returns either an `errors` array (with one message per offending field) or
 * a sanitized `values` object suitable for passing to the engine as `input`.
 *
 * Behaviour notes:
 * - Unknown fields in the payload are dropped (schema is authoritative).
 * - Missing optional fields fall back to `schema.default` when set,
 *   otherwise are omitted from the result entirely.
 * - Numeric strings ("3") coerce to numbers for type: "number".
 * - "true"/"false" coerce to booleans for type: "boolean".
 * - "json" fields accept either an object or a JSON string and parse it.
 * - "file" / "date" remain strings for now — full file support comes with the
 *   PWA upload surface.
 */
export interface InputValidationResult {
  errors: string[];
  values: Record<string, unknown>;
}

export function validateWorkflowInputs(
  schema: WorkflowInputsSchema | undefined,
  payload: unknown,
): InputValidationResult {
  const result: InputValidationResult = { errors: [], values: {} };
  if (!schema || Object.keys(schema).length === 0) {
    // No schema — caller decides what `input` looks like. Mirror it through.
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      result.values = { ...(payload as Record<string, unknown>) };
    }
    return result;
  }

  const obj =
    payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};

  for (const [name, field] of Object.entries(schema)) {
    const supplied = Object.hasOwn(obj, name) ? obj[name] : undefined;
    if (supplied === undefined || supplied === "" || supplied === null) {
      if (field.required) {
        result.errors.push(`Missing required input "${name}"`);
      } else if (field.default !== undefined) {
        result.values[name] = field.default;
      }
      continue;
    }
    const coerced = coerce(name, supplied, field, result.errors);
    if (coerced !== undefined) result.values[name] = coerced;
  }

  return result;
}

function coerce(name: string, raw: unknown, field: WorkflowInputSchema, errors: string[]): unknown {
  switch (field.type) {
    case "string":
    case "date":
    case "file": {
      if (typeof raw !== "string") {
        errors.push(`Input "${name}" must be a string`);
        return undefined;
      }
      if (field.enum && !field.enum.includes(raw)) {
        errors.push(`Input "${name}" must be one of: ${field.enum.join(", ")}`);
        return undefined;
      }
      return raw;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) {
        errors.push(`Input "${name}" must be a number`);
        return undefined;
      }
      if (field.min !== undefined && n < field.min) {
        errors.push(`Input "${name}" must be >= ${field.min}`);
        return undefined;
      }
      if (field.max !== undefined && n > field.max) {
        errors.push(`Input "${name}" must be <= ${field.max}`);
        return undefined;
      }
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string") {
        if (raw === "true") return true;
        if (raw === "false") return false;
      }
      errors.push(`Input "${name}" must be boolean`);
      return undefined;
    }
    case "json": {
      if (typeof raw === "object") return raw;
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          errors.push(`Input "${name}" must be valid JSON`);
          return undefined;
        }
      }
      errors.push(`Input "${name}" must be a JSON object or string`);
      return undefined;
    }
  }
}

/**
 * Validate a workflow's inputs schema itself (called during loader validation
 * so malformed schemas surface at save time rather than at run time).
 */
export function validateInputsSchema(schema: unknown, path = "inputs"): string[] {
  if (schema === undefined) return [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [`${path} must be an object mapping field names to schemas`];
  }
  const errors: string[] = [];
  const validTypes = new Set(["string", "number", "boolean", "date", "file", "json"]);
  for (const [name, raw] of Object.entries(schema as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${path}.${name} must be an object`);
      continue;
    }
    const field = raw as Record<string, unknown>;
    if (typeof field.type !== "string" || !validTypes.has(field.type)) {
      errors.push(`${path}.${name}.type must be one of ${[...validTypes].join(", ")}`);
    }
    if (field.enum !== undefined && (!Array.isArray(field.enum) || field.enum.some((v) => typeof v !== "string"))) {
      errors.push(`${path}.${name}.enum must be an array of strings`);
    }
    if (field.min !== undefined && typeof field.min !== "number") {
      errors.push(`${path}.${name}.min must be a number`);
    }
    if (field.max !== undefined && typeof field.max !== "number") {
      errors.push(`${path}.${name}.max must be a number`);
    }
  }
  return errors;
}
