import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostSandbox } from "../sandboxes/host.js";
import type { SandboxHandle } from "../sandboxes/interface.js";
import type { ToolContext } from "../tools/interface.js";
import { ReadTool } from "../tools/read.js";
import { WriteTool } from "../tools/write.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rw-tools-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s",
    workingDirectory: dir,
    env: {},
    ...overrides,
  };
}

describe("ReadTool sandbox routing", () => {
  it("uses host fs when no sandbox is set", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const tool = new ReadTool();
    const result = await tool.execute({ path: "a.txt" }, ctx());
    expect(result.success).toBe(true);
    expect(result.output).toBe("hello");
  });

  it("delegates to sandbox.readFile when sandbox+handle are set", async () => {
    const handle: SandboxHandle = { kind: "host", cwd: dir };
    const sandbox = {
      kind: "host" as const,
      prepare: vi.fn(),
      exec: vi.fn(),
      readFile: vi.fn().mockResolvedValue("from-sandbox"),
      writeFile: vi.fn(),
      cleanup: vi.fn(),
    };
    const tool = new ReadTool();
    const result = await tool.execute(
      { path: "a.txt" },
      ctx({ sandbox, sandboxHandle: handle }),
    );
    expect(result.success).toBe(true);
    expect(result.output).toBe("from-sandbox");
    expect(sandbox.readFile).toHaveBeenCalledWith(handle, join(dir, "a.txt"));
  });

  it("returns error when sandbox readFile throws", async () => {
    const sandbox = {
      kind: "host" as const,
      prepare: vi.fn(),
      exec: vi.fn(),
      readFile: vi.fn().mockRejectedValue(new Error("nope")),
      writeFile: vi.fn(),
      cleanup: vi.fn(),
    };
    const tool = new ReadTool();
    const result = await tool.execute(
      { path: "a.txt" },
      ctx({ sandbox, sandboxHandle: { kind: "host", cwd: dir } }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("nope");
  });
});

describe("WriteTool sandbox routing", () => {
  it("uses host fs when no sandbox is set", async () => {
    const tool = new WriteTool();
    const result = await tool.execute({ path: "out.txt", content: "data" }, ctx());
    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("data");
  });

  it("auto-creates parent directories on host fallback", async () => {
    const tool = new WriteTool();
    const result = await tool.execute({ path: "deep/nested/x.txt", content: "y" }, ctx());
    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, "deep/nested/x.txt"), "utf8")).toBe("y");
  });

  it("delegates to sandbox.writeFile when sandbox+handle are set", async () => {
    const handle: SandboxHandle = { kind: "host", cwd: dir };
    const sandbox = {
      kind: "host" as const,
      prepare: vi.fn(),
      exec: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    };
    const tool = new WriteTool();
    const result = await tool.execute(
      { path: "out.txt", content: "data" },
      ctx({ sandbox, sandboxHandle: handle }),
    );
    expect(result.success).toBe(true);
    expect(sandbox.writeFile).toHaveBeenCalledWith(handle, join(dir, "out.txt"), "data");
  });
});

describe("HostSandbox writeFile auto-mkdir", () => {
  it("creates parent directories that don't exist", async () => {
    const sb = new HostSandbox();
    const handle = await sb.prepare({ cwd: dir });
    await sb.writeFile(handle, "deep/nested/x.txt", "y");
    expect(readFileSync(join(dir, "deep/nested/x.txt"), "utf8")).toBe("y");
  });
});
