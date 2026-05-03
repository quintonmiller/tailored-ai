import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostSandbox } from "../sandboxes/host.js";

let dir: string;
const sandbox = new HostSandbox();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "host-sandbox-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("HostSandbox", () => {
  it("identifies as kind 'host'", () => {
    expect(sandbox.kind).toBe("host");
  });

  it("prepare returns a handle bound to cwd and env", async () => {
    const h = await sandbox.prepare({ cwd: dir, env: { FOO: "bar" } });
    expect(h.kind).toBe("host");
    expect(h.cwd).toBe(dir);
  });

  it("exec runs a successful command and returns stdout", async () => {
    const h = await sandbox.prepare({ cwd: dir });
    const r = await sandbox.exec(h, "echo hello");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");
  });

  it("exec surfaces non-zero exit codes without throwing", async () => {
    const h = await sandbox.prepare({ cwd: dir });
    const r = await sandbox.exec(h, "exit 7");
    expect(r.exitCode).not.toBe(0);
  });

  it("exec respects per-call env overrides", async () => {
    const h = await sandbox.prepare({ cwd: dir, env: { FOO: "from-handle" } });
    const r = await sandbox.exec(h, "echo $FOO", { env: { FOO: "from-call" } });
    expect(r.stdout.trim()).toBe("from-call");
  });

  it("exec uses handle cwd by default", async () => {
    const h = await sandbox.prepare({ cwd: dir });
    const r = await sandbox.exec(h, "pwd");
    expect(r.stdout.trim()).toBe(dir);
  });

  it("readFile + writeFile round-trip relative to handle cwd", async () => {
    const h = await sandbox.prepare({ cwd: dir });
    await sandbox.writeFile(h, "note.md", "hello");
    expect(await sandbox.readFile(h, "note.md")).toBe("hello");
  });

  it("readFile honors absolute paths", async () => {
    writeFileSync(join(dir, "abs.txt"), "abs-content");
    const h = await sandbox.prepare({ cwd: "/tmp" });
    expect(await sandbox.readFile(h, join(dir, "abs.txt"))).toBe("abs-content");
  });

  it("cleanup is a no-op", async () => {
    const h = await sandbox.prepare({ cwd: dir });
    await expect(sandbox.cleanup(h)).resolves.toBeUndefined();
  });
});
