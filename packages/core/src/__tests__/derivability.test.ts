import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import { parseCandidates, refuseIfAmbiguous } from "../agent/derivability.js";
import { classifyCommand, effectOf } from "../tools/effect.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolResult } from "../tools/interface.js";

/**
 * Measured on a 27B local model, three runs out of three: a session naming two
 * similarly-named staging buckets, a request to "delete the old staging
 * bucket", and a confident `Done — tai-staging-2024 has been deleted.` The pick
 * may even be right; the problem is that a coin flip and a considered choice
 * produce the same sentence.
 */

function saying(reply: string): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: false,
    async chat() {
      return { content: reply, usage: { input: 1, output: 1 }, finishReason: "stop", toolCalls: [] };
    },
  } as unknown as AIProvider;
}

const call = {
  model: "m",
  request: "go ahead and delete the old staging bucket",
  context: ["user: we have tai-staging-2024 and tai-staging-2026"],
  toolName: "exec",
  args: { command: "aws s3 rb s3://tai-staging-2024 --force" },
};

describe("refusing an irreversible call the request does not pin down", () => {
  it("refuses when the model names more than one candidate, and says which", async () => {
    const refusal = await refuseIfAmbiguous({ ...call, provider: saying("tai-staging-2024\ntai-staging-2026") });

    expect(refusal).toContain("tai-staging-2024 or tai-staging-2026");
    expect(refusal).toContain("cannot be undone");
    // A correction the agent can act on this turn, not a stopped turn.
    expect(refusal).toContain("Ask which one");
  });

  it("allows the call when only one thing fits", async () => {
    expect(await refuseIfAmbiguous({ ...call, provider: saying("tai-staging-2024") })).toBeNull();
  });

  it("fails open when the check itself cannot run", async () => {
    // Turning a provider outage into a blanket refusal of every destructive
    // action is a worse failure than the one being prevented.
    const broken = {
      id: "fake",
      name: "fake",
      supportsTools: false,
      async chat() {
        throw new Error("provider down");
      },
    } as unknown as AIProvider;

    expect(await refuseIfAmbiguous({ ...call, provider: broken })).toBeNull();
  });

  it("allows a prose answer rather than treating formatting as ambiguity", async () => {
    // One long line is one candidate. An unparseable reply is not evidence of
    // ambiguity, and refusing on it would make every irreversible call hostage
    // to how the model chose to phrase itself.
    const prose = "The only bucket that could be meant here is tai-staging-2024, from the old account.";
    expect(await refuseIfAmbiguous({ ...call, provider: saying(prose) })).toBeNull();
  });
});

describe("parseCandidates", () => {
  it("strips list markers and drops the empties", () => {
    expect(parseCandidates("- alpha\n\n* beta\n1. gamma\n")).toEqual(["alpha", "beta", "gamma"]);
  });

  it("reads an explicit nothing as nothing", () => {
    expect(parseCandidates("none")).toEqual([]);
  });
});

describe("classifyCommand", () => {
  it("calls a delete irreversible, wherever it hides in the line", () => {
    // The dangerous part is rarely first.
    for (const command of [
      "rm -rf build",
      "cd /tmp && rm -rf build",
      "find . -name '*.tmp' -exec rm {} \;",
      "ls | xargs rm",
      "aws s3 rb s3://bucket --force",
      "git push --force origin main",
      "psql -c 'DROP TABLE users'",
      "kubectl delete pod web-1",
    ]) {
      expect(classifyCommand(command), command).toBe("irreversible");
    }
  });

  it("calls a recoverable change a write", () => {
    for (const command of ["git commit -m wip", "mkdir build", "cp a b", "echo hi > out.txt"]) {
      expect(classifyCommand(command), command).toBe("write");
    }
  });

  it("leaves observation alone, which is what keeps the check affordable", () => {
    for (const command of ["git status", "ls -la", "cat README.md", "grep -r foo .", "df -h"]) {
      expect(classifyCommand(command), command).toBe("read");
    }
  });
});

describe("effectOf", () => {
  const tool = (effect?: Tool["effect"]): Tool =>
    ({ name: "t", description: "t", parameters: {}, effect, async execute() {
      return { success: true, output: "" };
    } }) as Tool;

  it("treats an undeclared tool as read, so nothing changes until a tool opts in", () => {
    expect(effectOf(tool(), {})).toBe("read");
  });

  it("reads a constant and a per-call classifier alike", () => {
    expect(effectOf(tool("write"), {})).toBe("write");
    expect(effectOf(tool((a) => (a.x === 1 ? "irreversible" : "read")), { x: 1 })).toBe("irreversible");
    expect(effectOf(tool((a) => (a.x === 1 ? "irreversible" : "read")), { x: 2 })).toBe("read");
  });

  it("treats a classifier that throws as irreversible, not as safe", () => {
    // A broken classifier on a destructive tool is exactly when the careful
    // path is wanted. Downgrading to `read` would fail silently and open.
    expect(
      effectOf(
        tool(() => {
          throw new Error("bad");
        }),
        {},
      ),
    ).toBe("irreversible");
  });
});

describe("the loop refuses through the gate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  /** Tries the destructive call once, then answers in prose when handed anything back. */
  function deleter(command: string): AIProvider {
    let tried = false;
    return {
      id: "fake",
      name: "fake",
      supportsTools: true,
      async chat(params: ChatParams): Promise<ChatResponse> {
        // The derivability check calls with no tools; so does the final ask.
        if (!params.tools?.length) {
          return {
            content: "tai-staging-2024\ntai-staging-2026",
            usage: { input: 1, output: 1 },
            finishReason: "stop",
            toolCalls: [],
          };
        }
        if (tried) {
          return {
            content: "Which one — 2024 or 2026?",
            usage: { input: 1, output: 1 },
            finishReason: "stop",
            toolCalls: [],
          };
        }
        tried = true;
        return {
          content: "",
          usage: { input: 1, output: 1 },
          finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "exec", arguments: { command } }],
        };
      },
    } as unknown as AIProvider;
  }

  function execTool(onRun: () => void): Tool {
    return {
      name: "exec",
      description: "run a command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      effect: (args: Record<string, unknown>) => classifyCommand(String(args.command ?? "")),
      async execute(): Promise<ToolResult> {
        onRun();
        return { success: true, output: "done" };
      },
    } as Tool;
  }

  async function run(command: string, extra: Record<string, unknown> = {}) {
    let ran = 0;
    let refusal: string | undefined;
    const reply = await runAgentLoop("go ahead and delete the old staging bucket", {
      db,
      session: newSession(db, "fake-model", "fake"),
      provider: deleter(command),
      tools: [execTool(() => ran++)],
      systemPrompt: "test",
      maxToolRounds: 4,
      maxHistoryTokens: 4000,
      onDerivabilityRefusal: (_t, r) => {
        refusal = r;
      },
      ...extra,
    });
    return { ran, refusal, reply };
  }

  it("does not run the delete, and hands back a correction the agent uses", async () => {
    const { ran, refusal, reply } = await run("aws s3 rb s3://tai-staging-2024 --force");

    expect(ran).toBe(0);
    expect(refusal).toContain("tai-staging-2024 or tai-staging-2026");
    // The turn continued: the agent got the refusal as a tool result and asked.
    expect(reply).toContain("2024");
    expect(reply).not.toContain("[Agent stopped");
  });

  it("lets a read straight through, which is what keeps this affordable", async () => {
    const { ran } = await run("git status");

    expect(ran).toBe(1);
  });

  it("can be switched off per deployment", async () => {
    const { ran, refusal } = await run("aws s3 rb s3://tai-staging-2024 --force", { checkDerivability: false });

    expect(ran).toBe(1);
    expect(refusal).toBeUndefined();
  });
});

describe("commands the first classifier missed", () => {
  it("catches the spelled-out cloud deletes, not just the abbreviations", () => {
    // `aws s3 rb` was caught and `aws s3api delete-bucket` was not, on the same
    // scenario in the same batch — the list knew the shorthand and not the verb.
    for (const command of [
      "aws s3api delete-bucket --bucket tai-staging-2024",
      "aws s3api delete-bucket --bucket b 2>&1 || echo FAILED",
      "gcloud storage buckets delete gs://old",
      "az storage container delete --name old",
    ]) {
      expect(classifyCommand(command), command).toBe("irreversible");
    }
  });

  it("still leaves listing alone", () => {
    for (const command of ["aws s3 ls", "aws s3api list-buckets", "gcloud storage buckets list"]) {
      expect(classifyCommand(command), command).toBe("read");
    }
  });
});
