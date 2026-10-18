/**
 * Who can store state, and who can declare a type.
 *
 * Both are plain registries. The SQLite provider registers through the same
 * door a plugin uses, and a plugin's type is resolved exactly like one from
 * config, so nothing core ships is privileged over a replacement.
 */
import type Database from "better-sqlite3";
import { type Disposer, Registry } from "../registry.js";
import type { StateProvider, StateTypeDef } from "./types.js";

export interface StateProviderContext {
  /** The runtime's database, for providers that keep their data beside it. */
  db?: Database.Database;
  /** `state.options`, or a type's `providerOptions`. Opaque to core. */
  options: Record<string, unknown>;
  /** Clock for timestamps. Injectable so tests and time providers agree. */
  now: () => Date;
}

export type StateProviderFactory = (ctx: StateProviderContext) => StateProvider | Promise<StateProvider>;

export const stateProviderRegistry = new Registry<StateProviderFactory>("state-provider");

export function registerStateProvider(id: string, factory: StateProviderFactory): Disposer {
  return stateProviderRegistry.register(id, factory);
}

/** Types plugins declare. Config declares its own under `state.types`, and wins on a name clash. */
export const stateTypeRegistry = new Registry<StateTypeDef>("state-type");

export function registerStateType(def: StateTypeDef): Disposer {
  return stateTypeRegistry.register(def.name, def);
}
