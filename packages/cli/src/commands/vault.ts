import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  createVaultTable,
  getVaultKey,
  initDatabase,
  parseVaultKey,
  vaultDelete,
  vaultGet,
  vaultList,
  vaultSet,
} from "@tailored-ai/core";
import { adoptHomeDir } from "../home.js";

const USAGE = `
Usage: tai vault <command> [args]

Commands:
  set <ref> <value> [--fetcher]   Store a secret. Reference uses $ns.key or ns.key.
  get <ref>                       Print a secret to stdout (use with care).
  list [--namespace <ns>]         List entries (metadata only — no values).
  delete <ref>                    Remove a secret.
  key generate                    Print a fresh vault encryption key (hex).
  help                            Show this help.

Flags (any subcommand):
  -c, --config <path>             Path to config.yaml.
  --db <path>                     Override the database path.
`.trim();

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function openDb(configOverride: string | undefined, dbOverride: string | undefined) {
  if (dbOverride) {
    return initDatabase(resolve(process.cwd(), dbOverride));
  }
  const home = adoptHomeDir(configOverride);
  return initDatabase(resolve(home, "data", "agent.db"));
}

export async function runVaultCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return;
  }

  // Strip --config/--db from the tail for parseArgs-friendly slicing.
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      db: { type: "string" },
      fetcher: { type: "boolean" },
      namespace: { type: "string", short: "n" },
    },
  });
  const cfg = values.config;
  const dbPath = values.db;

  switch (sub) {
    case "set": {
      const [ref, value] = positionals;
      if (!ref || value === undefined) fail("vault set <ref> <value>");
      const vk = parseVaultKey(ref);
      if (!vk) fail(`invalid reference: ${ref}. Use $ns.key or ns.key.`);
      const db = openDb(cfg, dbPath);
      createVaultTable(db);
      vaultSet(db, vk.namespace, vk.key, value, !!values.fetcher);
      console.log(`stored $${vk.namespace}.${vk.key}`);
      db.close();
      return;
    }
    case "get": {
      const [ref] = positionals;
      if (!ref) fail("vault get <ref>");
      const vk = parseVaultKey(ref);
      if (!vk) fail(`invalid reference: ${ref}`);
      const db = openDb(cfg, dbPath);
      const v = vaultGet(db, vk.namespace, vk.key);
      db.close();
      if (v === null) fail(`not found: $${vk.namespace}.${vk.key}`);
      process.stdout.write(`${v}\n`);
      return;
    }
    case "list": {
      const db = openDb(cfg, dbPath);
      createVaultTable(db);
      const entries = vaultList(db, values.namespace);
      for (const e of entries) {
        const tag = e.is_fetcher ? " [fetcher]" : "";
        console.log(`$${e.namespace}.${e.key}${tag}  (updated ${e.updated_at})`);
      }
      db.close();
      return;
    }
    case "delete": {
      const [ref] = positionals;
      if (!ref) fail("vault delete <ref>");
      const vk = parseVaultKey(ref);
      if (!vk) fail(`invalid reference: ${ref}`);
      const db = openDb(cfg, dbPath);
      const ok = vaultDelete(db, vk.namespace, vk.key);
      db.close();
      if (!ok) fail(`not found: $${vk.namespace}.${vk.key}`);
      console.log(`deleted $${vk.namespace}.${vk.key}`);
      return;
    }
    case "key": {
      const action = positionals[0];
      if (action !== "generate") fail("vault key generate");
      const key = getVaultKey();
      console.log(key.toString("hex"));
      console.log("Set TAI_VAULT_KEY env var or keep ~/.tailored-ai/vault.key (mode 600).");
      return;
    }
    default:
      fail(`unknown vault subcommand: ${sub}. Run "tai vault help".`);
  }
}
