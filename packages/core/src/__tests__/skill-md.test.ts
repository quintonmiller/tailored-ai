import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSkillMd,
  renderSkillMd,
  findSkillMdFile,
  isSkillMdPath,
} from "../resources/skill-md.js";
import { FileResourceSource } from "../resources/sources/file.js";

const FIXTURE = `---
name: pdf-processor
description: Extract text and metadata from PDFs.
license: MIT
allowed-tools:
  - read
  - exec
metadata:
  author: acme
---

# PDF Processor

Use this when the user asks to read or summarize a PDF file.

1. Confirm the path exists.
2. Run \`pdftotext\` via exec.
`;

describe("parseSkillMd", () => {
  it("parses a well-formed SKILL.md", () => {
    const r = parseSkillMd(FIXTURE, { dirName: "pdf-processor" });
    expect(r.manifest.kind).toBe("skill");
    expect(r.manifest.id).toBe("pdf-processor");
    expect(r.manifest.description).toBe("Extract text and metadata from PDFs.");
    expect(r.manifest.data?.toolRefs).toEqual(["read", "exec"]);
    expect(r.manifest.data?.instructions).toContain("# PDF Processor");
    expect(r.manifest.data?.license).toBe("MIT");
    expect(r.manifest.data?.metadata).toEqual({ author: "acme" });
  });

  it("accepts allowedTools as a camelCase alias", () => {
    const text = `---
name: foo
description: bar baz
allowedTools: [read]
---
body`;
    const r = parseSkillMd(text);
    expect(r.manifest.data?.toolRefs).toEqual(["read"]);
  });

  it("rejects a missing frontmatter block", () => {
    expect(() => parseSkillMd("just markdown, no frontmatter")).toThrow(/frontmatter/);
  });

  it("rejects a missing name", () => {
    const text = `---
description: hi
---
body`;
    expect(() => parseSkillMd(text)).toThrow(/`name`/);
  });

  it("rejects a missing description", () => {
    const text = `---
name: foo
---
body`;
    expect(() => parseSkillMd(text)).toThrow(/`description`/);
  });

  it("rejects an invalid name (uppercase)", () => {
    const text = `---
name: BadName
description: hi
---
body`;
    expect(() => parseSkillMd(text)).toThrow(/must match/);
  });

  it("rejects when dir name doesn't match", () => {
    expect(() => parseSkillMd(FIXTURE, { dirName: "wrong-dir" })).toThrow(/parent directory/);
  });

  it("accepts org-prefixed name with matching last-segment dir", () => {
    const text = `---
name: acme/widget
description: example
---
body`;
    const r = parseSkillMd(text, { dirName: "widget" });
    expect(r.manifest.id).toBe("acme/widget");
  });
});

describe("renderSkillMd round-trip", () => {
  it("round-trips through parseSkillMd", () => {
    const text = renderSkillMd({
      name: "foo-bar",
      description: "Does foo bar things.",
      body: "## How\n\nDo it.",
      version: "1.2.3",
      allowedTools: ["read", "write"],
      license: "MIT",
    });
    const r = parseSkillMd(text, { dirName: "foo-bar" });
    expect(r.manifest.id).toBe("foo-bar");
    expect(r.manifest.version).toBe("1.2.3");
    expect(r.manifest.data?.toolRefs).toEqual(["read", "write"]);
    expect(r.manifest.data?.instructions).toContain("## How");
  });
});

describe("isSkillMdPath / findSkillMdFile", () => {
  it("detects SKILL.md path suffixes", () => {
    expect(isSkillMdPath("/x/y/SKILL.md")).toBe(true);
    expect(isSkillMdPath("/x/y/skill.md")).toBe(true);
    expect(isSkillMdPath("/x/y/manifest.yaml")).toBe(false);
  });

  it("finds SKILL.md in a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "tai-skill-md-"));
    writeFileSync(join(dir, "SKILL.md"), FIXTURE, "utf8");
    expect(findSkillMdFile(dir)).toBe(join(dir, "SKILL.md"));
    rmSync(dir, { recursive: true });
  });
});

describe("FileResourceSource + SKILL.md", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tai-skill-src-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads a SKILL.md-based skill from a directory", async () => {
    const skillDir = join(dir, "pdf-processor");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), FIXTURE, "utf8");
    const src = new FileResourceSource();
    const fetched = await src.fetch(skillDir, { cacheDir: dir });
    expect(fetched.manifest.kind).toBe("skill");
    expect(fetched.manifest.id).toBe("pdf-processor");
    expect((fetched.manifest.data as any).toolRefs).toEqual(["read", "exec"]);
  });

  it("loads from an explicit SKILL.md file path", async () => {
    const skillDir = join(dir, "pdf-processor");
    mkdirSync(skillDir);
    const filePath = join(skillDir, "SKILL.md");
    writeFileSync(filePath, FIXTURE, "utf8");
    const src = new FileResourceSource();
    const fetched = await src.fetch(filePath, { cacheDir: dir });
    expect(fetched.manifest.id).toBe("pdf-processor");
  });

  it("prefers SKILL.md when both SKILL.md and manifest.yaml exist", async () => {
    const skillDir = join(dir, "pdf-processor");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), FIXTURE, "utf8");
    writeFileSync(
      join(skillDir, "manifest.yaml"),
      "kind: skill\nid: legacy/wrong\nversion: 0.0.0\n",
      "utf8",
    );
    const src = new FileResourceSource();
    const fetched = await src.fetch(skillDir, { cacheDir: dir });
    expect(fetched.manifest.id).toBe("pdf-processor"); // SKILL.md won
  });

  it("falls back to manifest.yaml and logs a deprecation warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const skillDir = join(dir, "legacy-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "manifest.yaml"),
      "kind: skill\nid: legacy/skill\nversion: 0.0.0\ndata:\n  instructions: hi\n",
      "utf8",
    );
    const src = new FileResourceSource();
    const fetched = await src.fetch(skillDir, { cacheDir: dir });
    expect(fetched.manifest.id).toBe("legacy/skill");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("DEPRECATION"));
    warn.mockRestore();
  });
});
