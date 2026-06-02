import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type NpmExecutor, PluginManager } from "../manager.js";

let homeDir: string;
let calls: { args: string[]; cwd: string }[];

beforeEach(() => {
  homeDir = mkdtempSync(resolve(tmpdir(), "tai-plugin-mgr-"));
  calls = [];
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

function fakeExecutor(opts: { ok?: boolean; stderr?: string } = {}): NpmExecutor {
  return (args, runOpts) => {
    calls.push({ args, cwd: runOpts.cwd });
    return { ok: opts.ok ?? true, stderr: opts.stderr };
  };
}

describe("PluginManager.bootstrap", () => {
  it("creates the plugin dir and a managed package.json", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    mgr.bootstrap();
    expect(existsSync(mgr.pluginDir)).toBe(true);
    expect(existsSync(mgr.packageJsonPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(mgr.packageJsonPath, "utf8")) as {
      name: string;
      private: boolean;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("tai-plugins");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toEqual({});
  });

  it("is idempotent — does not overwrite an existing package.json", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    mgr.bootstrap();
    writeFileSync(
      mgr.packageJsonPath,
      JSON.stringify({ name: "tai-plugins", dependencies: { "@org/foo": "1.0.0" } }, null, 2),
      "utf8",
    );
    mgr.bootstrap();
    const pkg = JSON.parse(readFileSync(mgr.packageJsonPath, "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toEqual({ "@org/foo": "1.0.0" });
  });
});

describe("PluginManager.install", () => {
  it("shells out to npm install --save with the supplied specs", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    const res = mgr.install(["@org/foo", "bar@2.0"]);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["install", "--save", "@org/foo", "bar@2.0"]);
    expect(calls[0].cwd).toBe(mgr.pluginDir);
  });

  it("returns ok true and skips npm when given no specs", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    const res = mgr.install([]);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("propagates failure from the executor", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor({ ok: false, stderr: "boom" }));
    const res = mgr.install(["@org/foo"]);
    expect(res.ok).toBe(false);
    expect(res.stderr).toBe("boom");
  });

  it("bootstraps the plugin home before invoking npm", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    expect(existsSync(mgr.packageJsonPath)).toBe(false);
    mgr.install(["foo"]);
    expect(existsSync(mgr.packageJsonPath)).toBe(true);
  });
});

describe("PluginManager.remove", () => {
  it("shells out to npm uninstall", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    const res = mgr.remove(["@org/foo"]);
    expect(res.ok).toBe(true);
    expect(calls[0].args).toEqual(["uninstall", "@org/foo"]);
  });
});

describe("PluginManager.upgrade", () => {
  it("runs `npm update` without args when no names supplied", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    mgr.upgrade([]);
    expect(calls[0].args).toEqual(["update"]);
  });

  it("scopes update to the supplied names", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    mgr.upgrade(["@org/foo", "bar"]);
    expect(calls[0].args).toEqual(["update", "@org/foo", "bar"]);
  });
});

describe("PluginManager.list", () => {
  it("returns the deps from the plugin home's package.json sorted by name", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    mgr.bootstrap();
    writeFileSync(
      mgr.packageJsonPath,
      JSON.stringify(
        {
          name: "tai-plugins",
          private: true,
          dependencies: { "@org/zeta": "9.0.0", "@org/alpha": "1.2.3" },
        },
        null,
        2,
      ),
      "utf8",
    );
    const installed = mgr.list();
    expect(installed.map((p) => p.name)).toEqual(["@org/alpha", "@org/zeta"]);
    expect(installed[0].version).toBe("1.2.3");
  });

  it("returns empty when the plugin home doesn't exist yet", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    expect(mgr.list()).toEqual([]);
  });

  it("returns empty when the package.json is malformed", () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    mgr.bootstrap();
    writeFileSync(mgr.packageJsonPath, "{ not json", "utf8");
    expect(mgr.list()).toEqual([]);
  });
});

describe("PluginManager.buildImporter", () => {
  it("returns a function that imports an installed plugin via the plugin home's package.json", async () => {
    // Build a fake "plugin" in the plugin home and reference it via deps.
    const mgr = new PluginManager(homeDir, fakeExecutor());
    mgr.bootstrap();
    const fakePluginRoot = resolve(mgr.pluginDir, "node_modules", "fake-plugin");
    // Mirror the npm layout that an install would produce.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(fakePluginRoot, { recursive: true });
    writeFileSync(
      resolve(fakePluginRoot, "package.json"),
      JSON.stringify({ name: "fake-plugin", main: "index.js", type: "module" }),
      "utf8",
    );
    writeFileSync(resolve(fakePluginRoot, "index.js"), "export const loaded = true;\n", "utf8");
    // Record the dep so list() would also see it.
    writeFileSync(
      mgr.packageJsonPath,
      JSON.stringify({ name: "tai-plugins", dependencies: { "fake-plugin": "0.0.0" } }, null, 2),
      "utf8",
    );

    const importer = mgr.buildImporter();
    const mod = (await importer("fake-plugin")) as { loaded?: boolean };
    expect(mod.loaded).toBe(true);
  });

  it("rejects with a helpful error when the plugin is not installed", async () => {
    const mgr = new PluginManager(homeDir, fakeExecutor());
    const importer = mgr.buildImporter();
    await expect(importer("not-installed")).rejects.toThrow(/not installed.*tai plugin install not-installed/);
  });
});

describe("PluginManager.spy", () => {
  // Last-mile sanity test: make sure the default executor is exported and uses
  // spawnSync so production wiring stays working. We don't actually invoke
  // npm here.
  it("default executor is a function", async () => {
    const mod = await import("../manager.js");
    expect(typeof mod.defaultNpmExecutor).toBe("function");
  });

  it("constructor accepts an optional custom executor", () => {
    const spy = vi.fn(() => ({ ok: true }));
    const mgr = new PluginManager(homeDir, spy as NpmExecutor);
    mgr.install(["x"]);
    expect(spy).toHaveBeenCalled();
  });
});
