import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyVars, expandPrompt } from "../prompts/expand.js";

describe("applyVars", () => {
  it("substitutes {{key}} placeholders", () => {
    expect(applyVars("hello {{name}}!", { name: "world" })).toBe("hello world!");
  });

  it("returns text unchanged when no placeholders present", () => {
    expect(applyVars("plain text", { name: "world" })).toBe("plain text");
  });

  it("handles repeated placeholders", () => {
    expect(applyVars("{{x}} + {{x}} = {{y}}", { x: "1", y: "2" })).toBe("1 + 1 = 2");
  });
});

describe("expandPrompt", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "expand-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("substitutes vars only when no other syntax is used", async () => {
    expect(await expandPrompt("hello {{name}}", { name: "agent" })).toBe("hello agent");
  });

  it("inlines a file via {{include:path}}", async () => {
    writeFileSync(join(dir, "snippet.md"), "snippet body");
    const out = await expandPrompt("intro\n{{include:snippet.md}}\noutro", {}, { baseDir: dir });
    expect(out).toBe("intro\nsnippet body\noutro");
  });

  it("expands vars inside an included file", async () => {
    writeFileSync(join(dir, "g.md"), "hello {{name}}");
    const out = await expandPrompt("{{include:g.md}}", { name: "world" }, { baseDir: dir });
    expect(out).toBe("hello world");
  });

  it("recurses includes up to maxIncludeDepth", async () => {
    writeFileSync(join(dir, "a.md"), "A->{{include:b.md}}");
    writeFileSync(join(dir, "b.md"), "B->{{include:c.md}}");
    writeFileSync(join(dir, "c.md"), "C");
    const out = await expandPrompt("{{include:a.md}}", {}, { baseDir: dir, maxIncludeDepth: 5 });
    expect(out).toBe("A->B->C");
  });

  it("emits an error marker on missing include without throwing", async () => {
    const out = await expandPrompt("{{include:nope.md}}", {}, { baseDir: dir });
    expect(out).toMatch(/\[include error: /);
  });

  it("emits an error marker when include depth is exceeded", async () => {
    // a.md includes itself — would recurse forever without the depth guard.
    writeFileSync(join(dir, "a.md"), "{{include:a.md}}");
    const out = await expandPrompt("{{include:a.md}}", {}, { baseDir: dir, maxIncludeDepth: 2 });
    expect(out).toMatch(/max depth 2 exceeded/);
  });

  it("does not run !`cmd` when allowShellExpansion is false", async () => {
    const out = await expandPrompt("status: !`echo hello`", {}, { allowShellExpansion: false });
    expect(out).toBe("status: !`echo hello`");
  });

  it("expands !`cmd` when allowShellExpansion is true", async () => {
    const out = await expandPrompt("greet: !`echo hello`", {}, { allowShellExpansion: true });
    expect(out).toBe("greet: hello");
  });

  it("substitutes !`shell error: ...` on shell failure rather than failing the call", async () => {
    const out = await expandPrompt("x: !`exit 1`", {}, { allowShellExpansion: true, shellTimeoutMs: 2000 });
    expect(out).toMatch(/^x: \[!shell error: /);
  });

  it("expands vars before shell so shell commands can use them", async () => {
    const out = await expandPrompt("!`echo {{greeting}}`", { greeting: "hi" }, { allowShellExpansion: true });
    expect(out).toBe("hi");
  });
});
