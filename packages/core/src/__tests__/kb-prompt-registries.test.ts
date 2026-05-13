import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KbRegistry, PromptRegistry, populateBuiltinKbs } from "../resources/index.js";
import { expandPrompt } from "../prompts/expand.js";

describe("KbRegistry + populateBuiltinKbs", () => {
  it("registers one resource per top-level kb subdir", () => {
    const dir = mkdtempSync(join(tmpdir(), "kb-test-"));
    mkdirSync(join(dir, "engineering"), { recursive: true });
    writeFileSync(join(dir, "engineering/README.md"), "# Engineering\nDocs for the eng org.\n");
    mkdirSync(join(dir, "sales"), { recursive: true });
    mkdirSync(join(dir, ".hidden"), { recursive: true });

    const reg = new KbRegistry();
    populateBuiltinKbs(reg, dir);

    const ids = reg.list().map((k) => k.id).sort();
    expect(ids).toContain("kb/global");
    expect(ids).toContain("kb/engineering");
    expect(ids).toContain("kb/sales");
    expect(ids).not.toContain("kb/.hidden");

    const eng = reg.get("kb/engineering");
    expect(eng?.rootPath).toContain("engineering");
    expect(eng?.description?.toLowerCase()).toContain("engineering");
  });

  it("is a no-op when the directory does not exist", () => {
    const reg = new KbRegistry();
    populateBuiltinKbs(reg, "/nonexistent/path");
    expect(reg.list().length).toBe(0);
  });

  it("rejects mis-kinded resources", () => {
    const reg = new KbRegistry();
    expect(() =>
      reg.register({
        manifest: { kind: "tool", id: "x", version: "1.0.0" },
        origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
        body: { rootPath: "/x" },
      }),
    ).toThrow(/expected manifest\.kind="kb"/);
  });
});

describe("PromptRegistry", () => {
  it("stores and retrieves prompt text", () => {
    const reg = new PromptRegistry();
    reg.registerBuiltin({ id: "my/checklist", text: "1. Verify\n2. Confirm\n3. Ship" });
    expect(reg.get("my/checklist")).toContain("Verify");
  });

  it("loads from a file with registerFromFile", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-test-"));
    const p = join(dir, "p.md");
    writeFileSync(p, "hello world");
    const reg = new PromptRegistry();
    reg.registerFromFile({ id: "p/test", path: p });
    expect(reg.get("p/test")).toBe("hello world");
  });

  it("rejects mis-kinded resources", () => {
    const reg = new PromptRegistry();
    expect(() =>
      reg.register({
        manifest: { kind: "tool", id: "x", version: "1.0.0" },
        origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
        body: { text: "x" },
      }),
    ).toThrow(/expected manifest\.kind="prompt"/);
  });
});

describe("expandPrompt + resolveResource", () => {
  it("expands {{include:resource://prompt:<id>}} via the resolver", async () => {
    const reg = new PromptRegistry();
    reg.registerBuiltin({ id: "p/intro", text: "Hello, {{name}}!" });

    const out = await expandPrompt(
      "Start: {{include:resource://prompt:p/intro}} End.",
      { name: "World" },
      {
        resolveResource: (uri) => {
          // uri = "resource://prompt:p/intro"
          const m = /^resource:\/\/prompt:(.+)$/.exec(uri);
          return m ? reg.get(m[1]) : undefined;
        },
      },
    );
    expect(out).toBe("Start: Hello, World! End.");
  });

  it("emits an inline error marker when the resource is missing", async () => {
    const out = await expandPrompt("{{include:resource://prompt:nope}}", {}, {
      resolveResource: () => undefined,
    });
    expect(out).toContain("[include error:");
    expect(out).toContain("resource not found");
  });

  it("emits an inline error when no resolveResource is supplied", async () => {
    const out = await expandPrompt("{{include:resource://prompt:any}}", {});
    expect(out).toContain("[include error:");
    expect(out).toContain("no resolveResource");
  });

  it("still resolves regular file includes alongside resource:// ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "expand-mix-"));
    const p = join(dir, "fragment.md");
    writeFileSync(p, "FILE-BODY");
    const reg = new PromptRegistry();
    reg.registerBuiltin({ id: "p/x", text: "RES-BODY" });

    const out = await expandPrompt(
      `[{{include:${p}}}] + [{{include:resource://prompt:p/x}}]`,
      {},
      {
        baseDir: dir,
        resolveResource: (uri) => (uri === "resource://prompt:p/x" ? reg.get("p/x") : undefined),
      },
    );
    expect(out).toBe("[FILE-BODY] + [RES-BODY]");
  });
});
