import type Database from "better-sqlite3";
import { InterfaceStore } from "./store.js";

export { boundCardProps } from "./bind.js";
export {
  type AgentAction,
  type BuildComponentInput,
  buildComponent,
  type ComponentKind,
  componentKindRegistry,
  InterfaceError,
  registerComponentKind,
} from "./kinds.js";
export { type RespondInput, type RespondOptions, type RespondResult, respondToComponent } from "./respond.js";
export {
  type ComponentRecord,
  type ComponentResponse,
  type ComponentStatus,
  InterfaceStore,
} from "./store.js";

const stores = new WeakMap<Database.Database, InterfaceStore>();

/** One store per database, shared by the tool and the HTTP routes. */
export function interfaceStoreFor(db: Database.Database): InterfaceStore {
  let store = stores.get(db);
  if (!store) {
    store = new InterfaceStore(db);
    stores.set(db, store);
  }
  return store;
}
