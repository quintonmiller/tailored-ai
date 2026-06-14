import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditTool } from "../tools/edit.js";
import type { ToolContext } from "../tools/interface.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edit-tool-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: "s", workingDirectory: dir, env: {}, ...overrides };
}

describe("EditTool", () => {
  it("replaces a unique exact match and writes the file", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1;\nconst y = 2;\n");
    const tool = new EditTool();
    const result = await tool.execute({ path: "a.ts", old_string: "const y = 2;", new_string: "const y = 3;" }, ctx());
    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("const x = 1;\nconst y = 3;\n");
  });

  it("errors when old_string is not found", async () => {
    writeFileSync(join(dir, "a.ts"), "hello");
    const tool = new EditTool();
    const result = await tool.execute({ path: "a.ts", old_string: "missing", new_string: "x" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("errors on an ambiguous (non-unique) match without replace_all", async () => {
    writeFileSync(join(dir, "a.ts"), "a\na\n");
    const tool = new EditTool();
    const result = await tool.execute({ path: "a.ts", old_string: "a", new_string: "b" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/matches 2 places/);
  });

  it("replaces every occurrence with replace_all", async () => {
    writeFileSync(join(dir, "a.ts"), "a\na\na\n");
    const tool = new EditTool();
    const result = await tool.execute({ path: "a.ts", old_string: "a", new_string: "b", replace_all: true }, ctx());
    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, "a.ts"), "utf8")).toBe("b\nb\nb\n");
  });

  it("errors when old_string equals new_string", async () => {
    writeFileSync(join(dir, "a.ts"), "x");
    const tool = new EditTool();
    const result = await tool.execute({ path: "a.ts", old_string: "x", new_string: "x" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("identical");
  });

  it("errors with a create hint when the file is missing", async () => {
    const tool = new EditTool();
    const result = await tool.execute({ path: "nope.ts", old_string: "a", new_string: "b" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("File not found");
  });

  it("routes through sandbox.readFile/writeFile when a sandbox is set", async () => {
    const handle = { kind: "host" as const, cwd: dir };
    const sandbox = {
      kind: "host" as const,
      prepare: vi.fn(),
      exec: vi.fn(),
      readFile: vi.fn().mockResolvedValue("foo BAR baz"),
      writeFile: vi.fn().mockResolvedValue(undefined),
      cleanup: vi.fn(),
    };
    const tool = new EditTool();
    const result = await tool.execute(
      { path: "a.ts", old_string: "BAR", new_string: "QUX" },
      ctx({ sandbox, sandboxHandle: handle }),
    );
    expect(result.success).toBe(true);
    expect(sandbox.readFile).toHaveBeenCalledWith(handle, join(dir, "a.ts"));
    expect(sandbox.writeFile).toHaveBeenCalledWith(handle, join(dir, "a.ts"), "foo QUX baz");
  });
});
