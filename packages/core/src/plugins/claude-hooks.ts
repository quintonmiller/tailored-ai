/**
 * A hook that is a program, speaking Claude Code's wire protocol.
 *
 * ## What this is actually for
 *
 * Not portability. The obvious pitch — "every hook script written for that
 * ecosystem runs against TAI unmodified" — does not survive contact with the
 * tool names: Claude Code has `Bash`, `Read`, `Write`, `Edit`; TAI has `exec`,
 * `read`, `write`, `edit`. Matchers are exact strings or regexes against the
 * literal name, so the single commonest example in the wild,
 * `"matcher": "Bash"`, matches nothing here. A script pointed at TAI would run
 * and silently gate nothing, which is worse than failing.
 *
 * What this delivers is that **a hook can be a program in any language**. The
 * built-in `tool` handler can only invoke something already registered in
 * TypeScript; this one runs anything on the box. Claude Code's JSON-on-stdin
 * shape is used because it is documented, already implemented by several
 * others, and there is no reason to invent a third one — not because a
 * borrowed script will work unedited.
 *
 * ## Why it is opt-in
 *
 * It hands *config* the ability to run arbitrary code with the agent's
 * privileges. Every other hook so far could only reach a tool the deployment
 * had already registered and enabled — a real boundary, and one that
 * disappears here. So this ships seeded-but-disabled, and the environment is
 * scrubbed of the variables a hook has no business inheriting.
 */

import { spawn } from "node:child_process";
import { type EventHookResult, registerEventHookHandler } from "../agent/event-hooks.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";

/** Claude Code's names for the two events TAI can honestly map. */
const EVENT_NAMES: Record<string, string> = {
  "agent.pre_tool_use": "PreToolUse",
  "agent.post_tool_use": "PostToolUse",
};

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Variables a hook has no business inheriting.
 *
 * Not a security boundary — the hook runs as the agent and can read anything
 * the agent can. It is hygiene against the specific accident of a hook picking
 * up a credential from the ambient environment and shipping it somewhere,
 * which is the shape a leak in this codebase has already taken once.
 */
const SCRUBBED = [/^.*_API_KEY$/, /^.*_TOKEN$/, /^.*_SECRET$/, /^AWS_/, /^OPENAI_/, /^ANTHROPIC_/, /^OTEL_/];

function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SCRUBBED.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * The payload, in the shape a Claude-dialect script expects.
 *
 * Field names are theirs (`snake_case`, `tool_name`, `tool_input`) so a script
 * written against their docs reads the right keys. What is deliberately not
 * translated is the *tool name itself* — `exec` goes over as `exec`. Renaming
 * it to `Bash` would manufacture a compatibility that does not exist and send
 * the hook's own logic after the wrong thing.
 */
function toClaudeInput(event: string, payload: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: payload.sessionId,
    hook_event_name: EVENT_NAMES[event] ?? event,
    cwd: process.cwd(),
    ...(payload.tool !== undefined ? { tool_name: payload.tool } : {}),
    ...(payload.args !== undefined ? { tool_input: payload.args } : {}),
    ...(payload.agent !== undefined ? { agent_type: payload.agent } : {}),
    ...(payload.output !== undefined ? { tool_response: payload.output } : {}),
  };
}

interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * The process never started — usually a `command` that is not on the box.
   *
   * Distinguished from every other failure because it decides the verdict.
   * An unregistered *tool* is skipped: the deployment may have disabled that
   * plugin elsewhere and an unrelated call should not pay for it. A `command`
   * is named right here in this hook, so its absence is unambiguous — the check
   * this call was supposed to get did not happen, and on a refusable event that
   * refuses.
   */
  spawnFailed?: string;
}

function runCommand(
  command: string,
  args: string[],
  input: string,
  cwd: string | undefined,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnFailed: string | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    // A spawn failure arrives here rather than as a throw, and `close` still
    // fires afterwards with a null code — indistinguishable from a program that
    // ran and said nothing unless it is recorded.
    child.on("error", (err) => {
      spawnFailed = err.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, spawnFailed });
    });

    child.stdin?.end(input);
  });
}

/**
 * Read a Claude-dialect answer.
 *
 * Their contract, narrowed to what TAI can act on:
 *
 * - **exit 2** blocks, with stderr as the reason.
 * - **stdout JSON** may carry `hookSpecificOutput.permissionDecision: "deny"`
 *   with a reason, `updatedInput` to rewrite the call, or `continue: false`.
 * - **anything else** is advisory: stdout becomes the hook's output, which
 *   `denyIf` can still match.
 *
 * A timeout is not a refusal, matching their documented behaviour — a hook that
 * ran out of time on `PreToolUse` does not block. TAI's own fail-closed default
 * still applies to a *thrown* error, which this never produces.
 */
export function readClaudeAnswer(outcome: CommandOutcome): EventHookResult {
  if (outcome.timedOut) return { output: outcome.stdout };

  const parsed = parseJson(outcome.stdout);
  const specific = (parsed?.hookSpecificOutput ?? {}) as Record<string, unknown>;

  if (specific.permissionDecision === "deny") {
    return { deny: String(specific.permissionDecisionReason ?? "denied by a hook") };
  }
  if (parsed?.continue === false) {
    return { deny: String(parsed.stopReason ?? "a hook stopped this turn") };
  }
  // Checked after the JSON, so an explicit decision wins over the exit code:
  // a script that says exactly why is more useful than one that only says no.
  if (outcome.code === 2) {
    return { deny: outcome.stderr.trim() || "denied by a hook (exit 2)" };
  }
  if (specific.updatedInput && typeof specific.updatedInput === "object") {
    return { args: specific.updatedInput as Record<string, unknown>, output: outcome.stdout };
  }
  return { output: outcome.stdout };
}

function parseJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(trimmed);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    // Their contract: malformed JSON is a non-blocking error, not a refusal.
    return undefined;
  }
}

/** Registers the `command` hook handler. Exported for tests. */
export function registerClaudeHookHandler(): () => void {
  return registerEventHookHandler("command", async (ctx) => {
    const options = ctx.hook.options ?? {};
    const command = typeof options.command === "string" ? options.command : undefined;
    if (!command) throw new Error("a `command` hook needs options.command");

    const args = Array.isArray(options.args) ? options.args.map(String) : [];
    const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    // Where the agent works, unless the hook says otherwise. A default, not a
    // boundary — nothing here can confine a subprocess, and `command` is the
    // handler that grants arbitrary execution in the first place. It is here so
    // a relative path means the same thing to a hook program as to the agent.
    const cwd = typeof options.cwd === "string" ? options.cwd : ctx.toolContext?.workingDirectoryBoundary;
    const extraEnv =
      options.env && typeof options.env === "object"
        ? Object.fromEntries(Object.entries(options.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {};

    const input = `${JSON.stringify(toClaudeInput(ctx.event, ctx.payload))}\n`;
    const outcome = await runCommand(command, args, input, cwd, scrubbedEnv(extraEnv), timeoutMs);
    // Thrown rather than returned, so it lands in the runner's fail-closed
    // path: the check this call was supposed to get did not happen.
    if (outcome.spawnFailed) throw new Error(`could not run "${command}": ${outcome.spawnFailed}`);
    return readClaudeAnswer(outcome);
  });
}

const plugin: Plugin = () => {
  const dispose = registerClaudeHookHandler();
  return () => dispose();
};

export const meta: PluginMeta = {
  name: "Claude-dialect hooks",
  description:
    "Adds the `command` hook handler: runs a program with Claude Code's JSON-on-stdin protocol. Grants config arbitrary code execution — opt in deliberately.",
  registers: [{ kind: "eventHookHandler", id: "command" }],
};

export default plugin;
