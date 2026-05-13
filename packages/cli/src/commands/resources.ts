import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  ApprovalGate,
  FileResourceSource,
  GitResourceSource,
  HttpResourceSource,
  Lockfile,
  NpmResourceSource,
  ResourceLoader,
  TaiRegistrySource,
  TrustStore,
  defaultLockfilePath,
  hashManifest,
} from "@agent/core";
import type { Resource, ResourceKind } from "@agent/core";

const SUBCOMMANDS = ["install", "uninstall", "list", "search", "trust", "help"] as const;

const USAGE = `
Usage: tai resources <command> [args]

Commands:
  install <uri> [--frozen]        Install a resource. --frozen requires a matching lockfile entry.
  uninstall <kind> <id>           Remove an installed resource and drop it from the lockfile.
  list                            List installed resources (from tai.lock).
  search <query>                  Search the default tai-registry index.
  trust <publicKey> <publisher>   Add a publisher to the trust store.
  help                            Show this help.

Global flags:
  --lockfile <path>               Override the lockfile path (default: ./tai.lock)
  --yes                           Auto-approve untrusted installs (use with care).
`.trim();

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function buildLoader(): ResourceLoader {
  const loader = new ResourceLoader();
  loader.addSource(new FileResourceSource());
  loader.addSource(new HttpResourceSource());
  loader.addSource(new GitResourceSource());
  loader.addSource(new NpmResourceSource());
  loader.addSource(new TaiRegistrySource());
  return loader;
}

async function installCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      frozen: { type: "boolean", default: false },
      lockfile: { type: "string" },
      yes: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const uri = positionals[0];
  if (!uri) fail("install requires a URI argument");

  const lockfilePath = values.lockfile ? resolve(values.lockfile) : defaultLockfilePath();
  const lock = Lockfile.read(lockfilePath);

  const loader = buildLoader();
  let res: Resource;
  try {
    res = await loader.load(uri);
  } catch (err) {
    fail(`failed to fetch ${uri}: ${(err as Error).message}`);
  }

  if (values.frozen) {
    const entry = lock.get(res.manifest.kind, res.manifest.id);
    if (!entry) fail(`--frozen: no lockfile entry for ${res.manifest.kind}/${res.manifest.id}`);
    if (entry.manifestHash !== hashManifest(res.manifest)) {
      fail(
        `--frozen: manifest hash mismatch for ${res.manifest.kind}/${res.manifest.id}\n  lock: ${entry.manifestHash}\n  got:  ${hashManifest(res.manifest)}`,
      );
    }
    console.log(`[ok] ${res.manifest.kind}/${res.manifest.id}@${res.manifest.version} matches lockfile`);
    return;
  }

  const trust = new TrustStore();
  const gate = new ApprovalGate({
    trust,
    handler: values.yes
      ? { async requestApproval() {
          return { approved: true, responseTimeMs: 0 };
        } }
      : { async requestApproval(req) {
          console.log("\n" + req.description);
          process.stdout.write("Approve? [y/N] ");
          const answer = await readOneLine();
          return { approved: /^y(es)?$/i.test(answer.trim()), responseTimeMs: 0 };
        } },
  });

  const decision = await gate.decide({ resource: res });
  if (!decision.approved) {
    fail(`install denied: ${decision.reason}`);
  }

  lock.upsertResource(res);
  lock.save();
  console.log(
    `[installed] ${res.manifest.kind}/${res.manifest.id}@${res.manifest.version} (${decision.cached ? "cached" : "approved"})`,
  );
  console.log(`            lockfile: ${lockfilePath}`);
}

function uninstallCommand(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      lockfile: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const kind = positionals[0] as ResourceKind | undefined;
  const id = positionals[1];
  if (!kind || !id) fail("uninstall requires <kind> <id>");

  const lockfilePath = values.lockfile ? resolve(values.lockfile) : defaultLockfilePath();
  const lock = Lockfile.read(lockfilePath);
  const removed = lock.remove(kind, id);
  if (!removed) fail(`${kind}/${id} not found in lockfile`);
  lock.save();
  new TrustStore().revokeResource(kind, id);
  console.log(`[uninstalled] ${kind}/${id}`);
}

function listCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { lockfile: { type: "string" } },
    strict: true,
  });
  const lockfilePath = values.lockfile ? resolve(values.lockfile) : defaultLockfilePath();
  const lock = Lockfile.read(lockfilePath);
  const entries = lock.list();
  if (entries.length === 0) {
    console.log(`(no resources installed in ${lockfilePath})`);
    return;
  }
  console.log(`Resources from ${lockfilePath}:\n`);
  for (const e of entries) {
    console.log(`  ${e.kind}/${e.id}@${e.version}  <- ${e.uri}`);
  }
}

async function searchCommand(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const query = positionals.join(" ");
  if (!query) fail("search requires a query");
  const src = new TaiRegistrySource();
  const hits = await src.search(query);
  if (hits.length === 0) {
    console.log(`no results for "${query}"`);
    return;
  }
  for (const h of hits) {
    console.log(`  ${h.kind}/${h.id}@${h.version}  ${h.description ?? ""}`);
    console.log(`    install: tai resources install tai-registry:${h.id}`);
    console.log(`    source:  ${h.source}`);
  }
}

function trustCommand(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  const key = positionals[0];
  const publisher = positionals[1];
  if (!key || !publisher) fail("trust requires <publicKey> <publisher>");
  const trust = new TrustStore();
  trust.trustPublisher(key, publisher);
  console.log(`[trusted] ${publisher} (${key})`);
}

async function readOneLine(): Promise<string> {
  return new Promise((resolveOut) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      chunks.push(chunk);
      const buf = chunks.join("");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolveOut(buf.slice(0, nl));
      }
    };
    process.stdin.on("data", onData);
    process.stdin.resume();
  });
}

export async function runResourcesCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(USAGE);
    return;
  }
  if (!SUBCOMMANDS.includes(sub as (typeof SUBCOMMANDS)[number])) {
    console.error(`unknown subcommand "${sub}"`);
    console.error(USAGE);
    process.exit(1);
  }
  const rest = args.slice(1);
  switch (sub) {
    case "install":
      return installCommand(rest);
    case "uninstall":
      return uninstallCommand(rest);
    case "list":
      return listCommand(rest);
    case "search":
      return searchCommand(rest);
    case "trust":
      return trustCommand(rest);
  }
}
