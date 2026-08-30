/**
 * The `script` hook handler: run a program, and let its exit code decide.
 *
 * This exists separately from the richer `command` handler in
 * `plugins/claude-hooks.ts` for one structural reason: **it must be available
 * before plugins load.** `tai:init:start` fires after config is read and before
 * anything else is constructed, and `builtin:*` plugins load in the second pass,
 * after the runtime. A lifecycle hook whose handler arrives later is a hook that
 * silently does not run.
 *
 * So this is deliberately the smaller of the two. No dialect, no JSON protocol,
 * no stdin:
 *
 * - **The payload arrives as environment**, not on stdin. That is not only
 *   simpler — writing to a child's stdin is how #606 happens, where a program
 *   that exits without reading raises an unhandled `EPIPE` from inside the
 *   runtime. A hook that ignores its input is a normal hook, and it should not
 *   be able to fault the process that ran it.
 * - **The exit code is the verdict.** Non-zero is a refusal, and on a refusable
 *   event that stops what was about to happen. Anything richer belongs in the
 *   `command` handler, which has a dialect for it.
 *
 * ## Why it is not registered on import
 *
 * A registered `script` handler hands *config* the ability to run arbitrary
 * programs with the agent's privileges. Every other hook can only reach a tool
 * the deployment already registered and enabled, which is a real boundary and
 * one this removes — the same reasoning that keeps `builtin:claude-hooks`
 * seeded `enabled: false`.
 *
 * That plugin's gate cannot work here, because "do not enable the plugin"
 * cannot gate something that must exist before plugins load. So the gate is
 * config: the bootstrap calls {@link registerScriptHookHandler} only when
 * `hooks.allowScripts` is true. When it is not, nothing registers the kind and
 * a `script` hook reports the ordinary "no handler" message — absent, not
 * silently ignored.
 */

import { spawn } from "node:child_process";
import { registerEventHookHandler } from "./event-hooks.js";

/** Default ceiling for one script, in milliseconds. */
export const DEFAULT_SCRIPT_HOOK_TIMEOUT_MS = 120_000;

/** `agentName` → `TAI_AGENT_NAME`. Anything not a letter or digit becomes `_`. */
function envKeyFor(key: string): string {
  return `TAI_${key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase()}`;
}

/**
 * Payload as environment variables.
 *
 * Scalars pass through as strings; anything structured is JSON, so a script can
 * parse it if it wants to and ignore it otherwise. `null` and `undefined` are
 * omitted rather than becoming the strings "null" and "undefined", which read
 * as values and are the classic way a shell script takes the wrong branch.
 */
export function payloadEnv(event: string, payload: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = { TAI_HOOK_EVENT: event };
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    env[envKeyFor(key)] =
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  }
  return env;
}

/**
 * Register the `script` kind. Returns a disposer, like every registration.
 *
 * Call this only when the deployment has opted in — see the note at the top of
 * this file.
 */
export function registerScriptHookHandler(): () => void {
  return registerEventHookHandler(
    "script",
    async (ctx) => {
      const opts = ctx.hook.options ?? {};
      const command = typeof opts.command === "string" ? opts.command : undefined;
      if (!command) {
        // Absent, not failed: a misdeclared hook is a wiring problem, and the
        // runner's own contract is that a wiring problem does not take an
        // unrelated operation down.
        return { skipped: "a `script` hook needs `options.command`" };
      }
      const args = Array.isArray(opts.args) ? opts.args.map(String) : [];
      const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : DEFAULT_SCRIPT_HOOK_TIMEOUT_MS;
      const extraEnv =
        opts.env && typeof opts.env === "object"
          ? (opts.env as Record<string, string>)
          : ({} as Record<string, string>);

      return await new Promise((resolve) => {
        const child = spawn(command, args, {
          env: { ...process.env, ...payloadEnv(ctx.event, ctx.payload), ...extraEnv },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let spawnFailed: string | undefined;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout?.on("data", (c) => {
          stdout += c.toString("utf8");
        });
        child.stderr?.on("data", (c) => {
          stderr += c.toString("utf8");
        });
        // A spawn failure arrives here rather than as a throw, and `close`
        // still fires afterwards with a null code — indistinguishable from a
        // program that ran and said nothing unless it is recorded.
        child.on("error", (err) => {
          spawnFailed = err.message;
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (spawnFailed) {
            // Could not be run at all. Absent, not a refusal: a hook that never
            // executed never had a verdict, and treating that as "no" would let
            // a typo in a path block the thing the hook was meant to guard.
            resolve({ skipped: `could not run ${command}: ${spawnFailed}` });
            return;
          }
          if (timedOut) {
            resolve({ deny: `${command} exceeded ${timeoutMs}ms`, output: stdout.trim() });
            return;
          }
          if (code !== 0) {
            const detail = stderr.trim() || stdout.trim() || `exit ${code}`;
            resolve({ deny: detail, output: stdout.trim() });
            return;
          }
          resolve({ output: stdout.trim() });
        });
      });
    },
    // The whole point: a program needs a process and nothing else, so this is
    // the one handler that can run before the runtime exists.
    { requires: "process" },
  );
}
