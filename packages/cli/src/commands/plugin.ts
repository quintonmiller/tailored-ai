import { resolveHomeDir } from "../home.js";
import { PluginManager } from "../plugins/manager.js";

const PLUGIN_USAGE = `
Usage: tai plugin <command> [args]

Commands:
  install <pkg-spec>...     Install one or more plugins into the TAI plugin home
  remove <pkg-name>...      Uninstall plugins
  list                      Show installed plugins
  upgrade [<pkg-name>...]   Update installed plugins (all if none specified)
  help                      Show this help

Plugins land in \`<home>/plugins/\` and are resolved at runtime from there.
After install, add the plugin id to \`config.yaml\`'s \`plugins:\` list to
enable it on startup.
`.trim();

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

export async function runPluginCommand(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(PLUGIN_USAGE);
    return;
  }

  // Honor -c/--config so users can scope the plugin home to a non-default config.
  // Strip flag pairs out of rest before passing to npm.
  let configOverride: string | undefined;
  const cleaned: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-c" || arg === "--config") {
      configOverride = rest[i + 1];
      i++;
    } else if (arg.startsWith("--config=")) {
      configOverride = arg.slice("--config=".length);
    } else {
      cleaned.push(arg);
    }
  }
  const homeDir = resolveHomeDir(configOverride);
  const manager = new PluginManager(homeDir);

  switch (subcommand) {
    case "install":
    case "add": {
      if (cleaned.length === 0) fail("Usage: tai plugin install <pkg-spec> [<pkg-spec>...]");
      console.log(`Installing into ${manager.pluginDir}...`);
      const res = manager.install(cleaned);
      if (!res.ok) {
        fail(`Install failed${res.stderr ? `: ${res.stderr}` : ""}.`);
      }
      console.log("\nInstall complete. Add to config.yaml to enable:");
      console.log("");
      console.log("plugins:");
      for (const spec of cleaned) {
        const name = stripSpecVersion(spec);
        console.log(`  - "${name}"`);
      }
      return;
    }
    case "remove":
    case "uninstall": {
      if (cleaned.length === 0) fail("Usage: tai plugin remove <pkg-name> [<pkg-name>...]");
      const res = manager.remove(cleaned);
      if (!res.ok) fail(`Remove failed${res.stderr ? `: ${res.stderr}` : ""}.`);
      console.log(`Removed: ${cleaned.join(", ")}`);
      console.log("Remember to remove the entry from config.yaml's `plugins:` list as well.");
      return;
    }
    case "list":
    case "ls": {
      const installed = manager.list();
      if (installed.length === 0) {
        console.log("(no plugins installed)");
        console.log(`Plugin home: ${manager.pluginDir}`);
        return;
      }
      for (const p of installed) {
        console.log(p.description ? `${p.name}@${p.version} — ${p.description}` : `${p.name}@${p.version}`);
      }
      return;
    }
    case "upgrade":
    case "update": {
      console.log(`Upgrading${cleaned.length > 0 ? ` ${cleaned.join(", ")}` : " all plugins"}...`);
      const res = manager.upgrade(cleaned);
      if (!res.ok) fail(`Upgrade failed${res.stderr ? `: ${res.stderr}` : ""}.`);
      return;
    }
    default:
      fail(`Unknown plugin command: ${subcommand}\n\n${PLUGIN_USAGE}`);
  }
}

/**
 * Strip an npm spec down to the package name. Handles plain names, scoped
 * names, version pins (`foo@1.0`), and tarball / git / file URLs (which are
 * left as-is — the user is responsible for using the package name in their
 * config.yaml in that case).
 */
function stripSpecVersion(spec: string): string {
  if (spec.includes("://") || spec.startsWith("file:") || spec.startsWith("git+") || spec.endsWith(".tgz")) {
    return spec;
  }
  if (spec.startsWith("@")) {
    // @scope/name@version → @scope/name
    const at = spec.indexOf("@", 1);
    return at === -1 ? spec : spec.slice(0, at);
  }
  const at = spec.indexOf("@");
  return at === -1 ? spec : spec.slice(0, at);
}
