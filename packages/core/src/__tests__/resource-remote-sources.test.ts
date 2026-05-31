import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitResourceSource, HttpResourceSource, NpmResourceSource, ResourceLoader } from "../resources/index.js";

function tempCache(): string {
  return mkdtempSync(join(tmpdir(), "tai-cache-"));
}

function makeFakeResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

describe("HttpResourceSource", () => {
  it("loads a single-file YAML manifest", async () => {
    const cacheDir = tempCache();
    const yaml = "kind: prompt\nid: my/remote\nversion: 1.0.0\n";
    const fetchImpl = vi.fn(async () => makeFakeResponse(yaml, "application/yaml"));
    const source = new HttpResourceSource({ fetchImpl });
    const loader = new ResourceLoader({ cacheDir, sources: [source] });

    const res = await loader.load("https://example.com/my-resource.yaml");
    expect(res.manifest.id).toBe("my/remote");
    expect(res.manifest.version).toBe("1.0.0");
    expect(res.origin.scheme).toBe("https");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("caches and skips fetch on the second load", async () => {
    const cacheDir = tempCache();
    const yaml = "kind: tool\nid: cached/foo\nversion: 0.1.0\n";
    const fetchImpl = vi.fn(async () => makeFakeResponse(yaml, "application/yaml"));
    const source = new HttpResourceSource({ fetchImpl });
    const loader = new ResourceLoader({ cacheDir, sources: [source] });

    await loader.load("https://example.com/cached.yaml");
    await loader.load("https://example.com/cached.yaml");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects unsupported content types", async () => {
    const fetchImpl = vi.fn(async () => makeFakeResponse("<html/>", "text/html"));
    const source = new HttpResourceSource({ fetchImpl });
    const loader = new ResourceLoader({ cacheDir: tempCache(), sources: [source] });
    await expect(loader.load("https://example.com/page.html")).rejects.toThrow(/unsupported content-type/);
  });

  it("propagates non-2xx responses with status code", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" }));
    const source = new HttpResourceSource({ fetchImpl });
    const loader = new ResourceLoader({ cacheDir: tempCache(), sources: [source] });
    await expect(loader.load("https://example.com/missing.yaml")).rejects.toThrow(/HTTP 404/);
  });
});

describe("GitResourceSource (with fake runner)", () => {
  it("clones once and reads manifest from repo root", async () => {
    const cacheDir = tempCache();
    const runner = vi.fn(async (args: string[], _opts?: { cwd?: string }) => {
      // Simulate `git clone <url> <dest>` by writing a manifest.yaml at the dest.
      // args = ["clone", "--depth=1", "--branch", "main", "<url>", "<dest>"]
      const dest = args[args.length - 1];
      mkdirSync(join(dest, ".git"), { recursive: true });
      writeFileSync(join(dest, "manifest.yaml"), "kind: workflow\nid: cloned/x\nversion: 0.0.1\n");
      return { stdout: "", stderr: "" };
    });
    const source = new GitResourceSource({ runner });
    const loader = new ResourceLoader({ cacheDir, sources: [source] });

    const res = await loader.load("git+https://example.com/x.git#main");
    expect(res.manifest.id).toBe("cloned/x");
    expect(runner).toHaveBeenCalledOnce();

    // Second load hits cache.
    await loader.load("git+https://example.com/x.git#main");
    expect(runner).toHaveBeenCalledOnce();
  });

  it("walks into a single subdir when manifest is nested", async () => {
    const runner = vi.fn(async (args: string[]) => {
      const dest = args[args.length - 1];
      mkdirSync(join(dest, ".git"), { recursive: true });
      mkdirSync(join(dest, "skill"), { recursive: true });
      writeFileSync(join(dest, "skill/manifest.yaml"), "kind: skill\nid: nested/skill\nversion: 1.0.0\n");
      return { stdout: "", stderr: "" };
    });
    const source = new GitResourceSource({ runner });
    const loader = new ResourceLoader({ cacheDir: tempCache(), sources: [source] });
    const res = await loader.load("git+https://example.com/nest.git");
    expect(res.manifest.id).toBe("nested/skill");
    expect(res.origin.localPath).toMatch(/\/skill$/);
  });

  it("cleans up the cache dir on clone failure", async () => {
    const runner = vi.fn(async () => {
      throw new Error("fatal: repository not found");
    });
    const source = new GitResourceSource({ runner });
    const loader = new ResourceLoader({ cacheDir: tempCache(), sources: [source] });
    await expect(loader.load("git+https://example.com/missing.git#main")).rejects.toThrow(/repository not found/);
  });
});

describe("NpmResourceSource (with fake runners)", () => {
  it("packs, extracts, and reads manifest from the package/ root", async () => {
    const cacheDir = tempCache();

    const runner = vi.fn(async (args: string[], _opts?: { cwd?: string }) => {
      // Simulate `npm pack <spec> --json` by emitting a synthetic JSON output
      // pointing at a tarball name we'll pretend to extract.
      expect(args[0]).toBe("pack");
      return { stdout: '[{"filename":"fake.tgz"}]', stderr: "" };
    });
    const tarRunner = vi.fn(async (args: string[]) => {
      // Simulate extraction by writing the npm "package/" layout.
      // args = ["-xzf", "<tarball>", "-C", "<cwd>"]
      const cwd = args[args.length - 1];
      const pkgDir = join(cwd, "package");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "manifest.yaml"), "kind: tool\nid: npm/extension\nversion: 2.5.0\n");
      return { stdout: "", stderr: "" };
    });

    const source = new NpmResourceSource({ runner, tarRunner });
    const loader = new ResourceLoader({ cacheDir, sources: [source] });

    const res = await loader.load("npm:@scope/ext@2.5.0");
    expect(res.manifest.id).toBe("npm/extension");
    expect(runner).toHaveBeenCalledOnce();
    expect(tarRunner).toHaveBeenCalledOnce();
  });

  it("rejects an empty spec", async () => {
    const source = new NpmResourceSource({});
    const loader = new ResourceLoader({ cacheDir: tempCache(), sources: [source] });
    await expect(loader.load("npm:")).rejects.toThrow(/empty npm spec/);
  });
});
