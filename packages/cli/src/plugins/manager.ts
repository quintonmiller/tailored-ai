import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Manual resolver for pure-ESM packages whose `exports` map only declares
 * the `import` condition. Reads the package's manifest from the plugin
 * home's node_modules and picks the best entry point. Returns the absolute
 * path of a JS file, or null when the package isn't there at all.
 */
function resolveEsmEntry(pluginDir: string, name: string): string | null {
  const pkgPath = resolve(pluginDir, "node_modules", name, "package.json");
  if (!existsSync(pkgPath)) return null;
  let pkg: {
    main?: string;
    module?: string;
    exports?:
      | string
      | {
          [k: string]: string | { import?: string; default?: string; require?: string };
        };
  };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as typeof pkg;
  } catch {
    return null;
  }
  const pkgDir = dirname(pkgPath);
  let entry: string | undefined;
  if (typeof pkg.exports === "string") {
    entry = pkg.exports;
  } else if (pkg.exports && typeof pkg.exports === "object") {
    const root = pkg.exports["."];
    if (typeof root === "string") {
      entry = root;
    } else if (root && typeof root === "object") {
      entry = root.import ?? root.default ?? root.require;
    }
  }
  if (!entry) entry = pkg.module ?? pkg.main;
  if (!entry) return null;
  return resolve(pkgDir, entry);
}

/**
 * One installed plugin entry, as it appears in `~/.tailored-ai/plugins/package.json`.
 */
export interface InstalledPlugin {
  name: string;
  version: string;
}

/**
 * Injected so tests can stub npm without running it. Production wiring uses
 * `defaultNpmExecutor` which shells out to whichever npm is on PATH.
 */
export type NpmExecutor = (args: string[], opts: { cwd: string }) => { ok: boolean; stderr?: string };

export const defaultNpmExecutor: NpmExecutor = (args, opts) => {
  const result = spawnSync("npm", args, {
    cwd: opts.cwd,
    stdio: ["ignore", "inherit", "inherit"],
    encoding: "utf8",
  });
  return { ok: result.status === 0, stderr: result.stderr };
};

/**
 * Manages the TAI-owned plugin home at `<homeDir>/plugins/`. Everything plugin-
 * related goes through this — `tai plugin install`, the runtime importer, the
 * editor's Plugins row — so the user's own `node_modules` and global npm install
 * never enter the picture.
 *
 * Strategy: keep a minimal `package.json` in the plugin home, run `npm install`
 * against it for each plugin, and resolve at runtime via `createRequire` scoped
 * to that file. See [#43](https://github.com/quintonmiller/tailored-ai/issues/43).
 */
export class PluginManager {
  constructor(
    private readonly homeDir: string,
    private readonly executor: NpmExecutor = defaultNpmExecutor,
  ) {}

  /** Absolute path to the plugin home directory. */
  get pluginDir(): string {
    return resolve(this.homeDir, "plugins");
  }

  /** Absolute path to the plugin home's package.json. */
  get packageJsonPath(): string {
    return resolve(this.pluginDir, "package.json");
  }

  /**
   * Create `<homeDir>/plugins/package.json` if missing. Idempotent. Called
   * automatically before any operation that needs the dir to exist.
   */
  bootstrap(): void {
    if (!existsSync(this.pluginDir)) {
      mkdirSync(this.pluginDir, { recursive: true });
    }
    if (!existsSync(this.packageJsonPath)) {
      const pkg = {
        name: "tai-plugins",
        private: true,
        description: "Plugin home for the `tai` CLI. Managed by `tai plugin`.",
        dependencies: {},
      };
      writeFileSync(this.packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
    }
  }

  /**
   * Install one or more package specs (any spec npm accepts —
   * `@scope/name`, `name@1.0`, `git+https://...`, `file:./local`).
   */
  install(specs: string[]): { ok: boolean; stderr?: string } {
    this.bootstrap();
    if (specs.length === 0) return { ok: true };
    return this.executor(["install", "--save", ...specs], { cwd: this.pluginDir });
  }

  /** Uninstall by package name. */
  remove(names: string[]): { ok: boolean; stderr?: string } {
    this.bootstrap();
    if (names.length === 0) return { ok: true };
    return this.executor(["uninstall", ...names], { cwd: this.pluginDir });
  }

  /** Read the plugin home's package.json and list installed deps. */
  list(): InstalledPlugin[] {
    if (!existsSync(this.packageJsonPath)) return [];
    let parsed: { dependencies?: Record<string, string> };
    try {
      parsed = JSON.parse(readFileSync(this.packageJsonPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
    } catch {
      return [];
    }
    const deps = parsed.dependencies ?? {};
    return Object.entries(deps)
      .map(([name, version]) => ({ name, version }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Run `npm update [name...]`. Pass no names to update everything. */
  upgrade(names: string[]): { ok: boolean; stderr?: string } {
    this.bootstrap();
    return this.executor(names.length > 0 ? ["update", ...names] : ["update"], { cwd: this.pluginDir });
  }

  /**
   * Build the importer that {@link loadPlugins} expects. Resolves package
   * names relative to the plugin home's package.json — so a plugin only loads
   * when it was installed via `tai plugin install`.
   *
   * Tries CJS `createRequire().resolve` first because it's the cheapest
   * path and works for packages that publish a `main` field or expose
   * `default` / `require` in their exports map. Falls back to a manual
   * `exports.<key>.import` lookup for pure-ESM plugins where the exports
   * map only declares `import` — CJS resolve treats those as unresolvable
   * even though dynamic `import()` of the file path works fine.
   *
   * `import.meta.resolve(name, parentUrl)` would be the ideal API but
   * Node 24 ignores the `parentUrl` argument without
   * `--experimental-import-meta-resolve`, so a resolver scoped to the
   * plugin home isn't possible without flagging.
   *
   * Throws with a recovery hint when the plugin isn't installed (truly
   * absent — no package.json under `node_modules/<name>/`); the caller
   * catches per-plugin so one bad install doesn't stop the rest.
   */
  buildImporter(): (name: string) => Promise<unknown> {
    this.bootstrap();
    const req = createRequire(this.packageJsonPath);
    return async (name: string) => {
      // 1) Fast path: createRequire().resolve. Works whenever the
      //    package has a `main` field or its exports map includes a
      //    CJS-visible condition (`default`, `require`).
      let resolved: string | null = null;
      try {
        resolved = req.resolve(name);
      } catch {
        // Fall through to manual resolution for pure-ESM packages.
      }
      if (resolved) return import(resolved);

      // 2) Manual exports-map walk for pure-ESM packages. Read the
      //    plugin's package.json from the plugin home's node_modules,
      //    pick an entry from exports.import / exports.default /
      //    exports.require, then dynamic-import the resolved file.
      const manualEntry = resolveEsmEntry(this.pluginDir, name);
      if (manualEntry) {
        return import(pathToFileURL(manualEntry).href);
      }

      throw new Error(
        `plugin "${name}" is not installed in ${this.pluginDir}. ` + `Run \`tai plugin install ${name}\` and retry.`,
      );
    };
  }
}
