/**
 * The simulations this package ships with, and the registry they live in.
 *
 * Importing a simulation is what registers it — `registerSimulation` runs as a
 * module side effect — so there has to be one place that imports them all.
 * Without it `createSimulation("factory")` fails with "unknown simulation" in
 * any process that happens not to have touched the factory module, which is
 * every process except the ones that already knew about it.
 *
 * Everything else in the package imports the registry through here rather than
 * from `types.js`, so "can this name be resolved" has one answer instead of
 * depending on import order.
 */

import "./descent/index.js";
import "./factory/index.js";
import "./lock/index.js";
import "./workshop/index.js";

export {
  createSimulation,
  listSimulations,
  type Policy,
  registerSimulation,
  type SimEvent,
  type SimMetrics,
  type Simulation,
  type SimulationFactory,
  type SimulationOptions,
  simulationPolicies,
} from "./types.js";
