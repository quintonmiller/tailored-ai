/**
 * A hook that is a program, speaking Claude Code's wire protocol.
 *
 * Tested against real scripts on disk rather than a mocked spawn: the whole
 * point of this handler is the process boundary — stdin framing, exit codes,
 * stdout parsing — and a mock would assert my own assumptions about it back at
 * me. The reading of their contract is tested as a pure function alongside, so
 * the table of cases does not need a subprocess each.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listEventHookHandlers, runEventHooks } from "../agent/event-hooks.js";
import { readClaudeAnswer, registerClaudeHookHandler } from "../plugins/claude-hooks.js";

let dir: string;
let dispose: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tai-claude-hooks-"));
  dispose = registerClaudeHookHandler();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write an executable shell script and return its path. */
function script(body: string): string {
  const path = join(dir, `hook-${Math.abs(body.length)}-${body.charCodeAt(0)}.sh`);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function run(command: string, payload: Record<string, unknown> = { tool: "exec", args: { command: "ls" } }) {
  return runEventHooks({
    event: "agent.pre_tool_use",
    hooks: [{ type: "command", options: { command, timeoutMs: 10_000 } }],
    payload: { sessionId: "s", agent: "nova", ...payload },
    tools: [],
    sessionId: "s",
    refusable: true,
  });
}

describe("readClaudeAnswer", () => {
  const base = { code: 0, stdout: "", stderr: "", timedOut: false };

  it("blocks on exit 2, with stderr as the reason", () => {
    expect(readClaudeAnswer({ ...base, code: 2, stderr: "no writes to /etc\n" })).toEqual({
      deny: "no writes to /etc",
    });
  });

  it("prefers an explicit decision over the exit code", () => {
    // A script that says exactly why is more useful than one that only says no.
    const stdout = JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "path outside the workspace" },
    });
    expect(readClaudeAnswer({ ...base, code: 2, stdout })).toEqual({ deny: "path outside the workspace" });
  });

  it("reads continue: false as a refusal", () => {
    const stdout = JSON.stringify({ continue: false, stopReason: "budget exhausted" });
    expect(readClaudeAnswer({ ...base, stdout })).toEqual({ deny: "budget exhausted" });
  });

  it("reads updatedInput as a rewrite", () => {
    const stdout = JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "ls -l" } },
    });
    expect(readClaudeAnswer({ ...base, stdout }).args).toEqual({ command: "ls -l" });
  });

  it("treats malformed JSON as advisory, not a refusal", () => {
    // Their contract: a broken hook is a non-blocking error.
    expect(readClaudeAnswer({ ...base, stdout: "{not json" }).deny).toBeUndefined();
  });

  it("does not block on a timeout", () => {
    // Matching their documented behaviour: a hook that ran out of time on
    // PreToolUse does not block.
    expect(readClaudeAnswer({ ...base, code: null, timedOut: true, stderr: "..." }).deny).toBeUndefined();
  });

  it("passes plain stdout through for denyIf to match", () => {
    expect(readClaudeAnswer({ ...base, stdout: "verdict BLOCK" })).toEqual({ output: "verdict BLOCK" });
  });
});

describe("the command handler, end to end", () => {
  it("registers itself as a handler kind", () => {
    expect(listEventHookHandlers()).toContain("command");
  });

  it("hands the script the call on stdin, in their field names", async () => {
    const out = join(dir, "seen.json");
    const path = script(`cat > ${out}`);
    await run(path);

    const seen = JSON.parse(readFileSync(out, "utf8"));
    expect(seen.hook_event_name).toBe("PreToolUse");
    expect(seen.tool_name).toBe("exec");
    expect(seen.tool_input).toEqual({ command: "ls" });
    expect(seen.session_id).toBe("s");
  });

  it("does not rename the tool to look like theirs", async () => {
    // Translating `exec` to `Bash` would manufacture a compatibility that does
    // not exist and send the hook's own logic after the wrong thing.
    const out = join(dir, "name.json");
    await run(script(`cat > ${out}`));
    expect(JSON.parse(readFileSync(out, "utf8")).tool_name).toBe("exec");
  });

  it("blocks the call when the script exits 2", async () => {
    const result = await run(script('echo "not allowed" >&2\nexit 2'));
    expect(result.deny).toBe("not allowed");
  });

  it("rewrites the call when the script says so", async () => {
    const body = `cat > /dev/null\ncat <<'JSON'\n{"hookSpecificOutput":{"updatedInput":{"command":"ls -l"}}}\nJSON`;
    const result = await run(script(body));
    expect(result.args).toEqual({ command: "ls -l" });
  });

  it("allows a script that says nothing", async () => {
    const result = await run(script("cat > /dev/null\nexit 0"));
    expect(result.deny).toBeUndefined();
  });

  it("refuses when the binary does not exist", async () => {
    // Not a `skipped`: the handler ran and could not do its job, which on a
    // refusable event means the check has no verdict. TAI's fail-closed
    // default applies, unlike a merely advisory Claude-Code hook.
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(join(dir, "definitely-not-here"));
    expect(result.deny).toBeDefined();
  });

  it("scrubs credentials out of the environment it hands over", async () => {
    process.env.TAI_TEST_FAKE_API_KEY = "super-secret";
    try {
      const out = join(dir, "env.txt");
      await run(script(`env > ${out}`));
      const text = readFileSync(out, "utf8");
      expect(text).not.toContain("super-secret");
      // Not a boundary — the hook runs as the agent — but hygiene against the
      // specific accident of a credential riding along into a subprocess.
      expect(text).toContain("PATH=");
    } finally {
      delete process.env.TAI_TEST_FAKE_API_KEY;
    }
  });
});
