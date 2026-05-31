import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Resource, ResourceKind } from "@tailored-ai/core";
import {
  ApprovalGate,
  defaultLockfilePath,
  FileResourceSource,
  GitResourceSource,
  HttpResourceSource,
  hashManifest,
  Lockfile,
  NpmResourceSource,
  ResourceLoader,
  TaiRegistrySource,
  TrustStore,
} from "@tailored-ai/core";

const SUBCOMMANDS = ["install", "uninstall", "list", "search", "trust", "enable", "disable", "help"] as const;

const USAGE = `
Usage: tai resources <command> [args]

Commands:
  install <uri> [--frozen]        Install a resource. --frozen requires a matching lockfile entry.
  uninstall <kind> <id>           Remove an installed resource and drop it from the lockfile.
  list                            List installed resources (from tai.lock).
  search <query>                  Search the default tai-registry index.
  trust <publicKey> <publisher>   Add a publisher to the trust store.
  enable <skill-id> <agent>       Attach an installed skill to an agent (writes agents.<agent>.skills).
  disable <skill-id> <agent>      Remove a skill from an agent.
  help                            Show this help.

Global flags:
  --lockfile <path>               Override the lockfile path (default: ./tai.lock)
  --yes                           Auto-approve untrusted installs (use with care).
  --server <url>                  Server base URL (default: http://localhost:3000). Used by enable/disable.
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
      ? {
          async requestApproval() {
            return { approved: true, responseTimeMs: 0 };
          },
        }
      : {
          async requestApproval(req) {
            console.log(`\n${req.description}`);
            process.stdout.write("Approve? [y/N] ");
            const answer = await readOneLine();
            return { approved: /^y(es)?$/i.test(answer.trim()), responseTimeMs: 0 };
          },
        },
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

async function enableSkillCommand(args: string[], enable: boolean) {
  const { values, positionals } = parseArgs({
    args,
    options: { server: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const skillId = positionals[0];
  const agent = positionals[1];
  if (!skillId || !agent) {
    fail(`${enable ? "enable" : "disable"} requires <skill-id> <agent>`);
  }
  const server = (values.server ?? process.env.TAI_SERVER ?? "http://localhost:3000").replace(/\/$/, "");

  // 1. Fetch the agent + skill list so we can sanity-check before patching.
  const agentRes = await fetch(`${server}/api/agents`).catch((err: Error) => {
    fail(`could not reach ${server}/api/agents: ${err.message}. Is \`tai serve\` running?`);
  });
  if (!agentRes.ok) fail(`agent fetch failed (${agentRes.status})`);
  const agents = (await agentRes.json()) as Record<string, { skills?: string[]; skillLoading?: string }>;
  const existing = agents[agent];
  if (!existing) fail(`agent "${agent}" not found. Run \`tai --list-agents\` to see options.`);

  if (enable) {
    const skillsRes = await fetch(`${server}/api/skills`);
    if (skillsRes.ok) {
      const { skills } = (await skillsRes.json()) as { skills: Array<{ id: string }> };
      if (!skills.some((s) => s.id === skillId)) {
        fail(
          `skill "${skillId}" is not installed. Run \`tai resources list\` to see installed skills, ` +
            `or install one with \`tai resources install <uri>\`.`,
        );
      }
    }
  }

  const current = existing.skills ?? [];
  const next = enable ? Array.from(new Set([...current, skillId])) : current.filter((s) => s !== skillId);

  if (enable && next.length === current.length) {
    console.log(`[noop] skill "${skillId}" already enabled for ${agent}`);
    return;
  }
  if (!enable && next.length === current.length) {
    console.log(`[noop] skill "${skillId}" not enabled for ${agent}`);
    return;
  }

  const definition: Record<string, unknown> = { skills: next };
  // Default to progressive — eager merging bloats the system prompt and is
  // deprecated. Preserve any existing override.
  if (enable && !existing.skillLoading) definition.skillLoading = "progressive";

  const patch = await fetch(`${server}/api/agents/${encodeURIComponent(agent)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ definition }),
  });
  if (!patch.ok) {
    const body = await patch.text();
    fail(`agent patch failed (${patch.status}): ${body}`);
  }
  console.log(
    `[ok] ${enable ? "enabled" : "disabled"} skill "${skillId}" ${enable ? "for" : "on"} agent "${agent}". ` +
      `Skills now: ${next.length === 0 ? "(none)" : next.join(", ")}`,
  );
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
    case "enable":
      return enableSkillCommand(rest, true);
    case "disable":
      return enableSkillCommand(rest, false);
  }
}
