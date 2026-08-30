/**
 * Hooks bound to runtime events.
 *
 * `beforeRun` and `afterRun` are two fixed points. This is the rest of the bus,
 * reachable from config: name any event, filter it, run something, and — on an
 * event that can be refused — let the answer refuse it.
 *
 * The event catalog is deliberately TAI's own rather than a second one invented
 * for hooks. That is what makes a typo a `validateConfig` warning instead of a
 * hook that silently never fires, which is the failure this repo keeps
 * producing (see #561, where a whole trigger kind was advertised and never
 * dispatched).
 *
 * ## What runs a hook is a registry
 *
 * Core ships one handler, `tool`, which invokes a registered tool with the
 * runtime's context. That is the whole of what config could previously reach.
 *
 * Anything else — a subprocess speaking someone's wire protocol, an HTTP
 * endpoint, a model call — registers through {@link registerEventHookHandler}
 * and reads its own fields out of the opaque `options` bag. Core stays unaware
 * of them, which is the same split `tasks.backend` and `sandbox.backend` use:
 * an open selector, an opaque options bag, and no built-in privileged over a
 * plugin.
 *
 * The reason that matters here rather than being tidiness: a handler that
 * spawns a process hands config the ability to run arbitrary code with the
 * agent's privileges. That belongs behind a plugin somebody installs on
 * purpose, not in the module every deployment loads.
 */

import type { AgentConfig, EventHook } from "../config.js";
import { toolOutputText } from "../content/types.js";
import { expandPrompt } from "../prompts/expand.js";
import type { Tool, ToolContext } from "../tools/interface.js";
import {
  type HookTier,
  isRefusableLifecycleEvent,
  type LifecycleEvent,
  lifecycleTier,
  tierSatisfies,
} from "./lifecycle.js";

/**
 * One declaration site's hooks for one event.
 *
 * `agent` undefined means the top-level `hooks.on` — the deployment's own,
 * fired on every occurrence. Most events cannot be scoped to an agent at all
 * (a task transition or a proposal opening does not belong to one), so without
 * a place to declare hooks that are not an agent's, two thirds of the catalog
 * had nowhere to be declared that would fire.
 */
export interface ResolvedEventHooks {
  agent?: string;
  event: string;
  hooks: EventHook[];
}

/** Everything a handler is given about one occurrence. */
export interface EventHookContext {
  /** The event name, so a handler that speaks a dialect can translate it. */
  event: string;
  /** The declaration, including the handler's own `options`. */
  hook: EventHook;
  /** The event payload, exactly as the bus carried it. */
  payload: Record<string, unknown>;
  sessionId: string;
  /** Whether this event can be refused. A `deny` from a handler is ignored when false. */
  refusable: boolean;
  /** The runtime's tools, for handlers that invoke one. */
  tools: Tool[];
  /**
   * The limits a tool invoked from this hook runs under — the declaring
   * agent's boundary and command rules.
   *
   * Supplied by the caller rather than assembled here, because only the
   * runtime can resolve an agent. Absent means no agent could be resolved, and
   * the handler treats that as "no additional privilege", never as
   * "unrestricted": a hook must not be able to reach anywhere the agent it
   * guards cannot.
   */
  toolContext?: Partial<ToolContext>;
  promptsConfig?: AgentConfig["prompts"];
}

export interface EventHookResult {
  /** What the handler produced. `denyIf` is matched against this. */
  output?: string;
  /**
   * An explicit refusal from the handler, independent of `denyIf`. A dialect
   * with its own refusal vocabulary — an exit code, a decision field — reports
   * it here rather than encoding it back into text for a regex to find.
   */
  deny?: string;
  /**
   * Set when nothing ran because the target was absent — a tool that is not
   * registered, a binary that does not exist. Reported, and never a refusal:
   * a hook that was never wired never had a verdict to lose, which is the
   * distinction that separates it from a hook that ran and threw.
   */
  skipped?: string;
  /**
   * Replacement for the payload's `args`, on an event that carries them.
   *
   * The difference between a guard that says no and one that says "not like
   * that" — narrow a path, drop a flag, cap a limit. A later hook in the same
   * chain sees the rewritten call, so a second check reviews what will actually
   * run rather than what was first asked for.
   *
   * Ignored on an event that cannot be refused: rewriting a record of something
   * that already happened would make the record a lie.
   */
  args?: Record<string, unknown>;
}

export type EventHookHandler = (ctx: EventHookContext) => Promise<EventHookResult>;

/**
 * What has to exist for a handler to work.
 *
 * `process` — nothing but a running process and the config. A handler that
 * spawns a program needs no more than this.
 *
 * `runtime` — the database, the tool registry and the event bus are up. A
 * handler that invokes a tool needs all three.
 *
 * The tier exists because lifecycle hooks fire at moments when the runtime does
 * not exist: `tai:init:start` runs after config is read and before anything is
 * constructed. Without it, a `tool` hook declared there would resolve to a
 * handler that cannot work, and `runEventHooks` would log "no handler" and
 * continue — validating cleanly and doing nothing, which is the failure mode
 * this codebase keeps paying for.
 *
 * Deliberately not a closed union of *action* types. Handler kinds are an open
 * string so a plugin can register its own and core never learns its name; a
 * plugin declares which tier it needs, and the check stays structural.
 *
 * Defined in `lifecycle.ts` and re-exported here, so a handler author imports
 * the tier from the same module as `registerEventHookHandler`.
 */
export type { HookTier };
export interface RegisterEventHookHandlerOptions {
  /**
   * What this handler needs. Defaults to `runtime`, which is the conservative
   * answer: a handler that has not thought about it is assumed to need
   * everything, so it is excluded from the early phases rather than run there
   * and failing obscurely.
   */
  requires?: HookTier;
}

const handlers = new Map<string, EventHookHandler>();
const handlerTiers = new Map<string, HookTier>();

/**
 * Register a handler kind. Returns a disposer, so a plugin can undo itself on
 * reload — the contract every other registration in core now follows.
 */
export function registerEventHookHandler(
  kind: string,
  handler: EventHookHandler,
  opts: RegisterEventHookHandlerOptions = {},
): () => void {
  handlers.set(kind, handler);
  handlerTiers.set(kind, opts.requires ?? "runtime");
  return () => {
    if (handlers.get(kind) === handler) {
      handlers.delete(kind);
      handlerTiers.delete(kind);
    }
  };
}

/** What a registered kind needs, or undefined when nothing registered it. */
export function eventHookHandlerTier(kind: string): HookTier | undefined {
  return handlers.has(kind) ? (handlerTiers.get(kind) ?? "runtime") : undefined;
}

/**
 * Handler kinds available right now. Used to explain an unknown one.
 *
 * `tier` narrows to the kinds that can actually run in that phase, so an error
 * message at `tai:init:start` offers `script` rather than listing `tool` as
 * though it were a choice.
 */
export function listEventHookHandlers(tier?: HookTier): string[] {
  const kinds = [...handlers.keys()];
  const usable = tier ? kinds.filter((k) => tierSatisfies(tier, handlerTiers.get(k) ?? "runtime")) : kinds;
  return usable.sort();
}

/**
 * Core's own handler: call a registered tool.
 *
 * Registered here rather than special-cased in the runner, so the built-in goes
 * through the same path a plugin's does and cannot quietly depend on being
 * first.
 */
registerEventHookHandler(
  "tool",
  async (ctx) => {
    const name = ctx.hook.tool;
    if (!name) throw new Error("a `tool` hook needs a `tool:` name");

    const tool = ctx.tools.find((t) => t.name === name);
    // Absent, not failed. See the note on the catch in `runEventHooks`.
    if (!tool) return { skipped: `tool "${name}" is not registered` };

    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ctx.hook.args ?? {})) {
      args[key] =
        typeof value === "string" ? await expandPrompt(value, stringVars(ctx.payload), ctx.promptsConfig) : value;
    }

    // The agent's own limits, not the process's. A hook that called `exec` used
    // to run outside the deployment's command rules, and one that called `write`
    // outside the agent's file boundary — so the guard was more privileged than
    // what it guarded. `workingDirectory` follows the boundary when there is one:
    // a relative path in a hook's `args` should resolve where the agent works,
    // not wherever the server happens to have been started.
    const extras = ctx.toolContext ?? {};
    const context: ToolContext = {
      sessionId: ctx.sessionId,
      workingDirectory: extras.workingDirectoryBoundary ?? process.cwd(),
      env: {},
      ...extras,
    };
    const result = await tool.execute(args, context);
    if (result.success === false) throw new Error(result.error ?? "(no detail)");
    return { output: toolOutputText(result.output) };
  },
  // Needs the tool registry, so it cannot run at `tai:init:start`.
  { requires: "runtime" },
);

/**
 * Collect every config-declared event hook, across agents.
 *
 * Flat rather than nested by agent, because dispatch is by event: the bus
 * subscribes once per event name and then asks which agents care.
 */
export function resolveEventHooks(config: AgentConfig): ResolvedEventHooks[] {
  const out: ResolvedEventHooks[] = [];

  // Deployment-level first, deliberately: the deployment's policy gets first
  // refusal, and a refusal stops the chain. An agent's own hook cannot preempt
  // a rule the operator set for everyone.
  for (const [event, declared] of Object.entries(config.hooks?.on ?? {})) {
    const hooks = Array.isArray(declared) ? declared : [declared];
    if (hooks.length > 0) out.push({ event, hooks });
  }

  for (const [agent, block] of Object.entries(config.agents ?? {})) {
    const on = block?.hooks?.on;
    if (!on) continue;
    for (const [event, declared] of Object.entries(on)) {
      const hooks = Array.isArray(declared) ? declared : [declared];
      if (hooks.length > 0) out.push({ agent, event, hooks });
    }
  }
  return out;
}

/**
 * Does this payload match a hook's `when`?
 *
 * Exact by default, `/…/` for a regex. Exactness is the safer default for a
 * matcher that gates tool execution: an unanchored pattern quietly matching a
 * neighbouring tool name is the wrong kind of surprise in a security control,
 * and it is the mistake Claude Code's own matcher docs spend a paragraph
 * warning about.
 *
 * A field the payload does not have never matches. Saying "this hook wanted
 * something that is not there" is more useful than treating absence as a
 * wildcard, which would fire the hook on every event of that name.
 */
export function matchesWhen(payload: Record<string, unknown>, when: Record<string, string> | undefined): boolean {
  if (!when) return true;
  for (const [key, want] of Object.entries(when)) {
    const value = payload[key];
    if (value === undefined || value === null) return false;
    const actual = String(value);
    if (want.length > 1 && want.startsWith("/") && want.endsWith("/")) {
      try {
        if (!new RegExp(want.slice(1, -1)).test(actual)) return false;
      } catch {
        // A malformed regex matches nothing rather than everything. The
        // permissive reading of a broken pattern would silently widen a gate.
        return false;
      }
      continue;
    }
    if (actual !== want) return false;
  }
  return true;
}

export interface RunEventHooksOptions {
  /** The event these hooks are bound to. */
  event: string;
  hooks: EventHook[];
  payload: Record<string, unknown>;
  tools: Tool[];
  /** See {@link EventHookContext.toolContext}. */
  toolContext?: Partial<ToolContext>;
  sessionId: string;
  /** Whether this event can be refused. Decides what a `denyIf` or an error means. */
  refusable: boolean;
  promptsConfig?: AgentConfig["prompts"];
  logPrefix?: string;
  /**
   * What exists at this point in the process. Defaults to `runtime`, so every
   * existing caller — all of which dispatch from a live runtime — is unchanged.
   *
   * A lifecycle caller passes `process` for the phases where the runtime does
   * not exist, and a hook needing more than that is refused with a reason
   * rather than dispatched into a handler that cannot work.
   */
  tier?: HookTier;
}

/**
 * Run one event's hooks in order.
 *
 * Returns a refusal when a hook asks for one, and stops at the first: a second
 * opinion after a refusal changes nothing, and running it would let a later
 * hook's side effects happen on an operation that is not going to occur.
 */
export async function runEventHooks(
  opts: RunEventHooksOptions,
): Promise<{ deny?: string; args?: Record<string, unknown> }> {
  const prefix = opts.logPrefix ?? "[event-hooks]";
  // Carried forward across the chain: a hook that rewrites the call is
  // rewriting it for the hooks after it too, so a later check reviews what will
  // actually run rather than what was first asked for.
  let payload = opts.payload;
  let rewritten: Record<string, unknown> | undefined;

  for (const hook of opts.hooks) {
    if (!matchesWhen(payload, hook.when)) continue;

    const kind = hook.type ?? "tool";

    // Refuse a handler that needs more than this phase has. Reported loudly:
    // the alternative is dispatching into a handler whose dependencies are
    // absent, which fails somewhere far from the declaration that caused it.
    const available = opts.tier ?? "runtime";
    const required = handlerTiers.get(kind);
    if (required && !tierSatisfies(available, required)) {
      console.error(
        `${prefix} hook type "${kind}" needs the ${required} to exist, and "${opts.event}" runs before it does — ` +
          `usable here: ${listEventHookHandlers(available).join(", ") || "(none)"}`,
      );
      continue;
    }

    const handler = handlers.get(kind);
    if (!handler) {
      // Absent, not failed — the distinction the catch below turns on. Nothing
      // registered this kind, which is a wiring problem (a plugin that did not
      // load), and a wiring problem should not take an unrelated operation
      // down. `listEventHookHandlers()` names what is available so the message
      // is actionable rather than a shrug.
      console.error(
        `${prefix} no handler for hook type "${kind}" — available: ${listEventHookHandlers().join(", ") || "(none)"}`,
      );
      continue;
    }

    try {
      const result = await handler({
        event: opts.event,
        hook,
        payload,
        sessionId: opts.sessionId,
        refusable: opts.refusable,
        tools: opts.tools,
        toolContext: opts.toolContext,
        promptsConfig: opts.promptsConfig,
      });

      if (result.skipped) {
        // Same reading as an unregistered handler: a disabled plugin or a
        // renamed tool is configuration, not a verdict.
        console.error(`${prefix} ${result.skipped}, skipping`);
        continue;
      }

      // A dialect with its own refusal vocabulary reports it directly; `denyIf`
      // is the text-matching fallback for handlers that only produce output.
      if (opts.refusable && result.deny) return { deny: result.deny };
      if (opts.refusable && hook.denyIf && result.output && new RegExp(hook.denyIf).test(result.output)) {
        return { deny: result.output };
      }
      // Only where the operation has not happened yet. Rewriting a record of
      // something already done would make the record a lie.
      if (opts.refusable && result.args) {
        rewritten = result.args;
        payload = { ...payload, args: result.args };
      }
    } catch (err) {
      const message = `hook "${hook.tool ?? kind}" failed: ${(err as Error).message}`;
      console.error(`${prefix} ${message}`);
      // Fail closed on anything refusable, unless told otherwise. A policy
      // check that ran and broke has an unknown verdict, and reading that as
      // approval is precisely the gap #545 describes. Distinct from *absent*
      // above: a hook that was never wired never had a verdict to lose.
      if (opts.refusable && (hook.onError ?? "abort") === "abort") {
        return { deny: `Refused: a policy hook could not run — ${message}` };
      }
    }
  }
  return rewritten ? { args: rewritten } : {};
}

/** Payload fields a hook's `args` templates can interpolate. */
function stringVars(payload: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    vars[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return vars;
}

/**
 * Run the hooks for one lifecycle event.
 *
 * Separate from {@link runEventHooks} only in what it decides for the caller:
 * the tier and the refusability both follow from the event, so a host cannot
 * get them out of step with each other.
 *
 * Lifecycle hooks are read from the **top-level** `hooks.on` alone. They belong
 * to the process, and there is no agent to scope them to when `tai:init:start`
 * fires — `validateConfig` says so rather than letting one bind under an agent
 * and never run.
 *
 * A refusal is returned, never thrown: only `tai:init:start` can refuse, and
 * its caller aborts the start. See {@link isRefusableLifecycleEvent}.
 */
export async function runLifecycleHooks(opts: {
  event: LifecycleEvent;
  config: AgentConfig;
  /** Empty at the `process` phases, where no registry exists yet. */
  tools?: Tool[];
  sessionId?: string;
  payload?: Record<string, unknown>;
}): Promise<{ deny?: string }> {
  const declared = opts.config.hooks?.on?.[opts.event];
  if (!declared) return {};
  const hooks = Array.isArray(declared) ? declared : [declared];
  if (hooks.length === 0) return {};

  return await runEventHooks({
    event: opts.event,
    hooks,
    payload: opts.payload ?? {},
    tools: opts.tools ?? [],
    sessionId: opts.sessionId ?? "lifecycle",
    refusable: isRefusableLifecycleEvent(opts.event),
    tier: lifecycleTier(opts.event),
    promptsConfig: opts.config.prompts,
    logPrefix: "[lifecycle]",
  });
}
