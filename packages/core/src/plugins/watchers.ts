/**
 * Watchers: cheap checks, with no model call, that wake an agent when
 * something it cares about changed. Off by default; turn it on with
 * `{ module: "builtin:watchers", enabled: true }`. See `docs/watchers.md`.
 *
 * It brings the `watch` record type (`watchers-records.ts`), the `watch` tool
 * agents keep theirs with (`watchers-tool.ts`), two kinds of check, `page`
 * and `price` (`watchers-kinds.ts`), and the runner that checks each watch
 * when it comes due and wakes its owner through `runtime.wakeAgent` when it
 * changed (`watchers-runner.ts`). Checks reach the network on `web_fetch`'s
 * terms (`watchers-fetch.ts`).
 *
 * The runner runs every kind registered through `ctx.watcherKinds`, a third
 * party's as well as these two. It registers through the same seams a
 * third-party plugin would, and core knows nothing about it.
 *
 * It takes no config of its own. Which agents get the `watch` tool is the
 * usual rule: every agent without a `tools:` list, and those whose list names
 * `watch`.
 */
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { Disposer } from "../registry.js";
import { createEgressPolicy } from "../security/egress-policy.js";
import type { StateService } from "../state/service.js";
import type { StateTypeDef } from "../state/types.js";
import { watchFetch } from "./watchers-fetch.js";
import { pageKind, priceKind } from "./watchers-kinds.js";
import { WATCH_TYPE, WATCH_TYPE_DEF } from "./watchers-records.js";
import { WatchRunner } from "./watchers-runner.js";
import { WatchTool } from "./watchers-tool.js";

/** The most a check reads of one answer. A page past this is refused, and the check fails. */
export const MAX_PAGE_BYTES = 2 * 1_048_576;
/** The least time between two checks reaching one host, across every watch. */
export const HOST_SPACING_MS = 10_000;

/**
 * The runner of the load in effect, or null once the plugin is unloaded with
 * nothing in its place. A reload swaps in the tool the new load builds, but a
 * call already running keeps the instance it started on: it reads this, so
 * its first look goes through the new runner, and a call running as the
 * plugin is turned off says so instead of failing against a type that's gone.
 */
let live: WatchRunner | null = null;

/** Say so when config declares a `watch` type: config wins, and its access rules apply instead of these. */
function warnReplaced(service: StateService, def: StateTypeDef): void {
  const declared = service.getType(def.name);
  if (declared && declared !== def) {
    console.warn(
      `[watchers] state.types in config declares "${def.name}", which replaces the watchers' own type of that name. ` +
        "Its access rules apply instead, so agents may be able to change each other's watches. Rename the config type to keep the watchers'.",
    );
  }
}

const plugin: Plugin = (ctx) => {
  const runtime = ctx.runtime;
  if (!runtime) return;
  const disposers: Disposer[] = [];

  // Each load registers its own copies: a registry's disposer removes an entry
  // only while it is the very object that call registered, so an older load
  // disposed late leaves a newer load's in.
  const type: StateTypeDef = { ...WATCH_TYPE_DEF };
  disposers.push(ctx.stateTypes.register(type));
  warnReplaced(runtime.getStateService(), type);
  disposers.push(ctx.watcherKinds.register({ ...pageKind }));
  disposers.push(ctx.watcherKinds.register({ ...priceKind }));

  const runner = new WatchRunner({
    service: () => runtime.getStateService(),
    kinds: ctx.watcherKinds,
    wake: (agent, opts) => runtime.wakeAgent(agent, opts),
    // One per check, so host spacing admits a check once per host. The policy is read per
    // request, so a reload that changes `security.egress` applies to the next check.
    fetchFor: () =>
      watchFetch({
        policy: () => createEgressPolicy(runtime.getConfig().security?.egress),
        spacingMs: HOST_SPACING_MS,
        maxBytes: MAX_PAGE_BYTES,
      }),
  });
  live = runner;
  disposers.push(() => {
    runner.stop();
    // Only ours: a newer load may already be in effect.
    if (live === runner) live = null;
  });

  ctx.tools.register("watch", (_cfg, tctx) =>
    tctx.getStateService
      ? [new WatchTool({ service: tctx.getStateService, kinds: ctx.watcherKinds, runner: () => live })]
      : [],
  );

  runner.start();

  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  };
};

export const meta: PluginMeta = {
  name: "Watchers",
  description:
    "Cheap checks, with no model call, that wake an agent when a page or a price it watches changed: the watch record and tool, the page and price kinds, and the runner for every kind a plugin brings.",
  registers: [
    { kind: "tool", id: "watch" },
    { kind: "stateType", id: WATCH_TYPE },
    { kind: "watcherKind", id: "page" },
    { kind: "watcherKind", id: "price" },
  ],
};

export default plugin;
