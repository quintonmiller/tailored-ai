/**
 * Who can supply a guardrail.
 *
 * A plain `Registry<GuardrailFactory>`, so the built-in text guardrail
 * registers through the same door a plugin uses and holds no privilege core
 * knows about.
 */

import type { Disposer } from "../registry.js";
import { Registry } from "../registry.js";
import textGuardrail from "./text.js";
import type { GuardrailFactory } from "./types.js";

export const guardrailRegistry = new Registry<GuardrailFactory>("guardrail");

export function registerGuardrail(id: string, factory: GuardrailFactory): Disposer {
  return guardrailRegistry.register(id, factory);
}

// Core's own guardrail, registered here rather than from the runtime so that
// importing the checker is enough to have it available — a deployment whose
// config says `use: text` should never depend on which module happened to be
// imported first. Guarded because `register` warns on replace, and a reload
// that re-imports must not look like a duplicate registration bug.
if (!guardrailRegistry.has("text")) guardrailRegistry.register("text", textGuardrail);
