/**
 * MemoryTool scoping and containment.
 *
 * This tool had no unit coverage at all, which is notable because it has the
 * widest blast radius in the prompt path: `scope: "global"` writes into the
 * directory `loadAllContext` injects into every agent's system prompt on every
 * turn. Everything here pins where a write lands, not what it says.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/interface.js";
import { MemoryTool } from "../tools/memory.js";

let root: string;
let globalDir: string;
let tool: MemoryTool;

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ sessionId: "s1", workingDirectory: "/", env: {}, ...over }) as ToolContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-tool-"));
  globalDir = join(root, "global");
  tool = new MemoryTool(globalDir);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("MemoryTool — where a write lands", () => {
  it("writes to the agent's own directory by default", async () => {
    const agentDir = join(root, "agents", "coder");

    const res = await tool.execute(
      { action: "write", file: "notes.md", content: "hello" },
      ctx({ agentName: "coder", agentContextDir: agentDir }),
    );

    expect(res.success).toBe(true);
    expect(readFileSync(join(agentDir, "notes.md"), "utf-8")).toBe("hello");
    expect(existsSync(join(globalDir, "notes.md"))).toBe(false);
  });

  it("writes to global only when global scope is asked for", async () => {
    const agentDir = join(root, "agents", "coder");

    await tool.execute(
      { action: "write", file: "shared.md", content: "for everyone", scope: "global" },
      ctx({ agentName: "coder", agentContextDir: agentDir }),
    );

    expect(readFileSync(join(globalDir, "shared.md"), "utf-8")).toBe("for everyone");
  });

  it("does NOT fall back to global when the session has no agent directory", async () => {
    // The bug: a "profile" write from an un-named CLI run, a Slack message or
    // an API call fell through to the GLOBAL directory. The caller asked for
    // its own notes and silently got every agent's prompt.
    const res = await tool.execute({ action: "write", file: "scratch.md", content: "mine", scope: "profile" }, ctx());

    expect(res.success).toBe(true);
    expect(existsSync(join(globalDir, "scratch.md"))).toBe(false);
    expect(readFileSync(join(root, "unscoped", "scratch.md"), "utf-8")).toBe("mine");
  });

  it("does not fall back to global with no scope and no agent either", async () => {
    await tool.execute({ action: "write", file: "scratch.md", content: "mine" }, ctx());

    expect(existsSync(join(globalDir, "scratch.md"))).toBe(false);
    expect(existsSync(join(root, "unscoped", "scratch.md"))).toBe(true);
  });

  it("says which directory it used, so the result is not misleading", async () => {
    const res = await tool.execute({ action: "write", file: "a.md", content: "x" }, ctx());

    // Not "profile" — it is not the caller's profile, and calling it one is how
    // nobody noticed the fallback.
    expect(res.output).toContain("unscoped");
  });

  it("appends under the same rules as write", async () => {
    await tool.execute({ action: "append", file: "log.md", content: "line" }, ctx());

    expect(existsSync(join(globalDir, "log.md"))).toBe(false);
    expect(readFileSync(join(root, "unscoped", "log.md"), "utf-8")).toContain("line");
  });
});

describe("MemoryTool — containment", () => {
  it("refuses a filename that is not a plain .md name", async () => {
    const res = await tool.execute(
      { action: "write", file: "../../../etc/passwd", content: "x" },
      ctx({ agentContextDir: join(root, "agents", "coder") }),
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("Invalid filename");
  });

  it("keeps knowledge-scope writes in the knowledge base", async () => {
    const kbDir = join(root, "kb");

    const res = await tool.execute(
      { action: "write", file: "ref.md", content: "reference", scope: "knowledge" },
      ctx({ kbDir }),
    );

    expect(res.success).toBe(true);
    expect(readFileSync(join(kbDir, "ref.md"), "utf-8")).toBe("reference");
    expect(existsSync(join(globalDir, "ref.md"))).toBe(false);
  });

  it("reports rather than fails when there is no knowledge base configured", async () => {
    const res = await tool.execute({ action: "write", file: "ref.md", content: "x", scope: "knowledge" }, ctx());

    expect(res.success).toBe(false);
    expect(res.error).toContain("knowledge base");
  });
});

describe("MemoryTool — a global write is announced", () => {
  it("warns, because it changes every agent's prompt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await tool.execute(
      { action: "write", file: "shared.md", content: "x", scope: "global" },
      ctx({ agentName: "channel-manager" }),
    );

    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("channel-manager");
    expect(said).toContain("GLOBAL");
  });

  it("stays quiet for an ordinary profile write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await tool.execute(
      { action: "write", file: "notes.md", content: "x" },
      ctx({ agentName: "coder", agentContextDir: join(root, "agents", "coder") }),
    );

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("GLOBAL"))).toEqual([]);
  });
});

describe("MemoryTool — reads follow the same resolution", () => {
  it("reads back what it wrote for a named agent", async () => {
    const agentDir = resolve(root, "agents", "coder");
    const withAgent = ctx({ agentName: "coder", agentContextDir: agentDir });
    await tool.execute({ action: "write", file: "notes.md", content: "remembered" }, withAgent);

    const res = await tool.execute({ action: "read", file: "notes.md" }, withAgent);

    expect(res.output).toBe("remembered");
  });
});
