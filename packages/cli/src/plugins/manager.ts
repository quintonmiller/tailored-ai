import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

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
   * Throws with a recovery hint when the plugin isn't installed; the loader
   * catches and reports per-plugin so other plugins still come up.
   */
  buildImporter(): (name: string) => Promise<unknown> {
    this.bootstrap();
    const req = createRequire(this.packageJsonPath);
    return (name: string) => {
      let resolved: string;
      try {
        resolved = req.resolve(name);
      } catch {
        return Promise.reject(
          new Error(
            `plugin "${name}" is not installed in ${this.pluginDir}. ` +
              `Run \`tai plugin install ${name}\` and retry.`,
          ),
        );
      }
      return import(resolved);
    };
  }
}
