import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { CustomTool } from "../tools/custom.js";
import type { ToolContext } from "../tools/interface.js";

describe("CustomTool shell substitution", () => {
  it("does not double-quote a placeholder the template already quoted", async () => {
    // `ls "{{path}}"` is the correct-looking thing to write, and what a model
    // writes. Escaping on top of it made the quotes part of the filename, so a
    // directory that plainly existed came back "No such file or directory".
    const tool = new CustomTool("echo_path", {
      description: "x",
      parameters: { path: { type: "string", description: "p" } },
      command: 'echo "{{path}}"',
    });

    const result = await tool.execute({ path: "/tmp/some dir" }, {} as ToolContext);

    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe("/tmp/some dir");
  });

  it("still escapes, so a value cannot break out of the command", async () => {
    const tool = new CustomTool("echo_path", {
      description: "x",
      parameters: { path: { type: "string", description: "p" } },
      command: 'echo "{{path}}"',
    });

    const result = await tool.execute({ path: 'a"; touch /tmp/pwned-by-custom-tool; echo "b' }, {} as ToolContext);

    expect(result.success).toBe(true);
    expect(existsSync("/tmp/pwned-by-custom-tool")).toBe(false);
    expect(result.output).toContain("touch");
  });

  it("handles an unquoted placeholder the same way", async () => {
    const tool = new CustomTool("echo_n", {
      description: "x",
      parameters: { n: { type: "number", description: "n" } },
      command: "echo {{n}}",
    });

    expect((await tool.execute({ n: 3 }, {} as ToolContext)).output.trim()).toBe("3");
  });

  it("expands a leading ~ but leaves a tilde elsewhere alone", async () => {
    const tool = new CustomTool("echo_path", {
      description: "x",
      parameters: { path: { type: "string", description: "p" } },
      command: 'echo "{{path}}"',
    });

    expect((await tool.execute({ path: "~/x" }, {} as ToolContext)).output.trim()).toBe(`${homedir()}/x`);
    expect((await tool.execute({ path: "a~b" }, {} as ToolContext)).output.trim()).toBe("a~b");
  });

  it("treats a parameter with a default as optional and substitutes it", async () => {
    // Declaring it required while the description says "Default 3" forces the
    // model to invent a value for something it was told it could omit.
    const tool = new CustomTool("depth", {
      description: "x",
      parameters: {
        path: { type: "string", description: "p" },
        max_depth: { type: "number", description: "d", default: 3 },
      },
      command: "echo {{path}} {{max_depth}}",
    });

    expect((tool.parameters as { required: string[] }).required).toEqual(["path"]);
    expect((await tool.execute({ path: "/tmp" }, {} as ToolContext)).output.trim()).toBe("/tmp 3");
  });

  it("applies the same parent-repo escape guard exec applies", async () => {
    // This tool used to discard its ToolContext entirely — the parameter was
    // named `_context` — and end at `bash -c` on the host, so none of the
    // guards `exec` applies were applied here.
    const tool = new CustomTool("peek", {
      description: "x",
      parameters: { path: { type: "string", description: "p" } },
      command: 'cat "{{path}}"',
    });

    const result = await tool.execute({ path: "/repo/src/secret.ts" }, {
      workingDirectoryBoundary: "/repo/.worktrees/agent/coder",
    } as unknown as ToolContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain("parent repo");
  });

  it("checks the boundary after substitution, so a parameter cannot smuggle a path", async () => {
    // The template alone looks confined; the escape arrives in an argument.
    const tool = new CustomTool("peek", {
      description: "x",
      parameters: { path: { type: "string", description: "p" } },
      command: "cat {{path}}",
    });

    const result = await tool.execute({ path: "/repo/package.json" }, {
      workingDirectoryBoundary: "/repo/.worktrees/agent/coder",
    } as unknown as ToolContext);

    expect(result.success).toBe(false);
  });

  it("routes through the sandbox when one is attached, instead of the host shell", async () => {
    const calls: string[] = [];
    const tool = new CustomTool("build", {
      description: "x",
      parameters: {},
      command: "make all",
    });

    const result = await tool.execute({}, {
      sandbox: {
        exec: async (_handle: unknown, cmd: string) => {
          calls.push(cmd);
          return { stdout: "built", stderr: "", exitCode: 0 };
        },
      },
      sandboxHandle: { id: "c1" },
    } as unknown as ToolContext);

    expect(calls).toEqual(["make all"]);
    expect(result.success).toBe(true);
    expect(result.output).toContain("built");
  });

  it("still runs on the host when there is no sandbox and no boundary", async () => {
    // The common case must keep working — this is not a lockdown, it is the
    // same two guards `exec` already applies.
    const tool = new CustomTool("echo_ok", {
      description: "x",
      parameters: {},
      command: "echo fine",
    });

    expect((await tool.execute({}, {} as ToolContext)).output.trim()).toBe("fine");
  });

  it("keeps every parameter required when none declares a default", async () => {
    const tool = new CustomTool("two", {
      description: "x",
      parameters: { a: { type: "string", description: "a" }, b: { type: "string", description: "b" } },
      command: "echo {{a}} {{b}}",
    });

    expect((tool.parameters as { required: string[] }).required).toEqual(["a", "b"]);
  });
});
