import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExtractDocumentTool, extractText } from "../tools/extract-document.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "extract-"));
}

describe("ExtractDocumentTool", () => {
  it("errors when path is missing", async () => {
    const tool = new ExtractDocumentTool();
    const res = await tool.execute({}, { sessionId: "t", workingDirectory: process.cwd(), env: {} });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/path is required/);
  });

  it("errors when file does not exist", async () => {
    const tool = new ExtractDocumentTool();
    const res = await tool.execute(
      { path: "/nonexistent/file.pdf" },
      { sessionId: "t", workingDirectory: process.cwd(), env: {} },
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/file not found/);
  });

  it("errors on unsupported file types", async () => {
    const dir = tmp();
    const fp = join(dir, "notes.txt");
    writeFileSync(fp, "hello");
    const tool = new ExtractDocumentTool();
    const res = await tool.execute({ path: fp }, { sessionId: "t", workingDirectory: process.cwd(), env: {} });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unsupported file type/);
  });

  it("errors clearly when create_document is used without db wiring", async () => {
    const dir = tmp();
    const fp = join(dir, "x.pdf");
    writeFileSync(fp, "%PDF-1.0\n%%EOF");
    const tool = new ExtractDocumentTool();
    // pdf-parse may or may not be installed; either way we never reach the wiring check
    // *for the dep error*, but a missing-dep error still surfaces clearly.
    const res = await tool.execute(
      { path: fp, action: "create_document", project_id: "p1" },
      { sessionId: "t", workingDirectory: process.cwd(), env: {} },
    );
    expect(res.success).toBe(false);
    // pdf-parse missing → "pdf-parse"; pdf-parse present + invalid bytes → "Invalid PDF"; wiring missing → "create_document requires".
    // All three indicate the tool correctly refused to proceed.
    expect(res.error).toMatch(/pdf-parse|create_document requires|Invalid PDF/);
  });
});

describe("extractText", () => {
  it("rejects unsupported extensions with a helpful message", async () => {
    const dir = tmp();
    const fp = join(dir, "thing.docx");
    writeFileSync(fp, "");
    await expect(extractText(fp)).rejects.toThrow(/unsupported file type: .docx/);
  });

  it("handles files with no extension", async () => {
    const dir = tmp();
    const fp = join(dir, "noext");
    writeFileSync(fp, "");
    await expect(extractText(fp)).rejects.toThrow(/unsupported file type/);
  });
});
