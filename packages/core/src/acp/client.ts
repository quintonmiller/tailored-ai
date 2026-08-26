/**
 * Driving another coding agent over the Agent Client Protocol.
 *
 * TAI could already delegate a coding task — `ClaudeCodeTool` shells out to the
 * `claude` binary with a prompt string. That is one-shot: no session to
 * continue, nothing streaming back while it works, no way to answer a
 * permission prompt, no way to cancel. ACP defines all of those, and a
 * subprocess call cannot carry any of them.
 *
 * This lives in core rather than in a plugin for the reason `mcp/` does: it is
 * a protocol-level capability, the `openai_compatible` of agent-driving. The
 * distinction that makes that safe is that **core knows the protocol and never
 * a vendor** — no agent's name, binary or arguments appears here or in
 * `DEFAULT_CONFIG`. Which agent to launch is a config block, exactly as
 * `mcp.servers` is.
 *
 * The SDK is an optional dependency, dynamically imported on first use, and
 * only structural types cross this boundary so core compiles without it.
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

/** How long a session may run before the child is killed, when config says nothing. */
export const DEFAULT_ACP_TIMEOUT_MS = 600_000;

/** How much of the child's stderr to keep for diagnosis. */
const STDERR_LIMIT = 4_000;

/**
 * What an agent may do when it asks.
 *
 * `deny` is the default, and deliberately: a coding agent asks permission
 * precisely when it is about to write a file or run a command, and an
 * unattended path answering "yes" on the owner's behalf is the failure this
 * codebase keeps producing (#545). A denial is reported in the tool result
 * along with the key that changes it, so the first run says what to do rather
 * than failing mutely.
 */
export type AcpPermissionPolicy = "deny" | "allow";

/** One agent TAI can drive, named entirely by config. */
export interface AcpAgentSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// --- Structural slice of the SDK. Only what core calls. ---

interface SdkPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** `session/request_permission` params, narrowed to what a decision needs. */
export interface AcpPermissionRequest {
  sessionId?: string;
  toolCall?: { title?: string; kind?: string };
  options?: SdkPermissionOption[];
}

export type AcpPermissionResponse = {
  outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string };
};

interface SdkSession {
  readonly sessionId: string;
  prompt(prompt: string): Promise<{ stopReason?: string }>;
  readText(): Promise<string>;
  dispose(): void;
}

interface SdkSessionBuilder {
  start(): Promise<SdkSession>;
}

interface SdkClientContext {
  buildSession(cwd: string): SdkSessionBuilder;
}

interface SdkClientApp {
  /** The handler is passed a context (`{ params, signal, agent }`), not bare params. */
  onRequest(
    method: string,
    handler: (context: { params: AcpPermissionRequest }) => AcpPermissionResponse,
  ): SdkClientApp;
  connectWith<T>(stream: unknown, op: (context: SdkClientContext) => Promise<T>): Promise<T>;
}

interface SdkModules {
  client(options?: { name: string; version?: string }): SdkClientApp;
  ndJsonStream(output: unknown, input: unknown): unknown;
}

let sdkPromise: Promise<SdkModules> | undefined;

/**
 * Import the SDK once. The `as string` specifier keeps tsc from statically
 * resolving an optional dependency — core must compile where it is absent.
 */
async function loadSdk(): Promise<SdkModules> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      try {
        const sdk = await import("@agentclientprotocol/sdk" as string);
        return { client: sdk.client, ndJsonStream: sdk.ndJsonStream } as SdkModules;
      } catch (err) {
        sdkPromise = undefined; // allow a retry once the user installs it
        throw new Error(
          `Driving an agent over ACP requires the "@agentclientprotocol/sdk" package (optional dependency). ` +
            `Install it next to @tailored-ai/core: npm install @agentclientprotocol/sdk — (${(err as Error).message})`,
        );
      }
    })();
  }
  return sdkPromise;
}

/**
 * Answer one permission request.
 *
 * Pure, and exported, because this is the security-relevant half and it should
 * be testable without a subprocess or a protocol.
 *
 * An agent supplies its own options and their kinds; core picks by *kind*
 * rather than by position or id, because neither is specified. `*_once` is
 * preferred over `*_always` in both directions: a standing grant is a policy
 * decision, and nothing here is entitled to make one on the owner's behalf.
 * With no usable option the answer is `cancelled`, which is the protocol's own
 * way of saying "no decision" and is the safe reading of an unanswerable ask.
 */
export function decidePermission(request: AcpPermissionRequest, policy: AcpPermissionPolicy): AcpPermissionResponse {
  const options = request.options ?? [];
  const wanted: SdkPermissionOption["kind"][] =
    policy === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

/** Human-readable name for what was asked, for the denial report. */
function describeAsk(request: AcpPermissionRequest): string {
  return request.toolCall?.title ?? request.toolCall?.kind ?? "an action";
}

export interface RunAcpPromptOptions {
  agent: AcpAgentSpec;
  prompt: string;
  /** Working directory for the session. The agent's own `cwd` overrides it. */
  cwd: string;
  policy: AcpPermissionPolicy;
  timeoutMs?: number;
  /**
   * Test seam: supply the connection instead of spawning one. Mirrors the same
   * seam on the MCP client, and lets the protocol path be exercised in-process
   * against a fake agent rather than mocked away.
   */
  openStream?: () => Promise<{ stream: unknown; close: () => void; stderr: () => string }>;
}

export interface AcpPromptResult {
  text: string;
  stopReason?: string;
  sessionId: string;
  /** What the agent asked to do and was refused. Empty when it asked nothing. */
  denied: string[];
}

/**
 * Spawn an agent, open a session, send one prompt, and return what it said.
 *
 * One prompt per call, deliberately. A persistent session is the obvious next
 * step and a different design question — it needs somewhere for the session to
 * live across tool calls, and an answer for what happens to it when the turn
 * ends.
 */
export async function runAcpPrompt(opts: RunAcpPromptOptions): Promise<AcpPromptResult> {
  const sdk = await loadSdk();
  const connection = opts.openStream ? await opts.openStream() : spawnAgent(opts.agent, sdk.ndJsonStream);
  const denied: string[] = [];

  const app = sdk.client({ name: "tailored-ai" }).onRequest("session/request_permission", ({ params }) => {
    const answer = decidePermission(params, opts.policy);
    if (opts.policy === "deny" || answer.outcome.outcome === "cancelled") denied.push(describeAsk(params));
    return answer;
  });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_ACP_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      connection.close();
      reject(new Error(`the agent did not finish within ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const work = app.connectWith(connection.stream, async (ctx) => {
      const session = await ctx.buildSession(opts.agent.cwd ?? opts.cwd).start();
      try {
        // Started before the text is read, not awaited first: chunks arrive as
        // notifications while the turn runs, and `readText` drains them until
        // the turn stops.
        const finished = session.prompt(opts.prompt);
        const text = await session.readText();
        const response = await finished;
        return { text, stopReason: response.stopReason, sessionId: session.sessionId, denied };
      } finally {
        session.dispose();
      }
    });
    return await Promise.race([work, deadline]);
  } catch (err) {
    const stderr = connection.stderr().trim();
    throw new Error(stderr ? `${(err as Error).message}\n[agent stderr]\n${stderr}` : (err as Error).message);
  } finally {
    if (timer) clearTimeout(timer);
    connection.close();
  }
}

/**
 * Launch the agent and wrap its stdio as the protocol's message stream.
 *
 * stderr is captured rather than inherited: a child that fails to start says so
 * there and nowhere else, and inheriting would scatter it into the host's log
 * where nothing correlates it with the tool call that caused it.
 */
function spawnAgent(
  agent: AcpAgentSpec,
  framing: SdkModules["ndJsonStream"],
): { stream: unknown; close: () => void; stderr: () => string } {
  const child = spawn(agent.command, agent.args ?? [], {
    cwd: agent.cwd,
    env: { ...process.env, ...agent.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let errText = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (errText.length < STDERR_LIMIT) errText += chunk.toString("utf8");
  });
  // A spawn failure — no such binary — arrives here rather than as a throw, so
  // it has to be collected like any other stderr or the eventual error says
  // only that the session never opened.
  child.on("error", (err) => {
    errText += `\n${err.message}`;
  });

  if (!child.stdin || !child.stdout) throw new Error("the agent process has no stdio to speak over");

  let closed = false;
  return {
    stream: framing(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    stderr: () => errText,
    close: () => {
      if (closed) return;
      closed = true;
      child.kill();
    },
  };
}
