/**
 * Ask a probe of a live model and report what it reached for.
 *
 * One chat completion per sample, with the character's own tool schemas and its
 * own private view — no harness, no room, no agent loop. That is the whole
 * point: the question is whether a model in this situation *finds* the tool,
 * and everything else in a run is machinery between the situation and the
 * answer.
 *
 *   npx tsx src/probe-run.ts --probes traitor-vial,party-bind --samples 8
 */

import { readFileSync } from "node:fs";
import { type ProbeResult, type ProbeSetup, probePrompt, stage } from "./probe.js";
import { PROBES } from "./probes.js";

interface Target {
  "base-url": string;
  model: string;
  "max-tokens"?: string;
  temperature?: string;
  thinking?: string;
}

/** The sim's tools, as the schema a chat-completions call wants. */
function toolSchemas(sim: unknown, agent: string): unknown[] {
  const s = sim as {
    sharedTools(): Array<{ name: string; description: string; parameters: unknown }>;
    tools(): Record<string, Array<{ name: string; description: string; parameters: unknown }>>;
  };
  const mine = [...(s.tools()[agent] ?? []), ...s.sharedTools()];
  const seen = new Set<string>();
  return mine
    .filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
    .map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}

async function askOnce(target: Target, setup: ProbeSetup, seed: number): Promise<ProbeResult> {
  const { sim, arranged, agent } = stage(setup, seed);
  const body = {
    model: target.model,
    temperature: Number(target.temperature ?? 0.7),
    max_tokens: Number(target["max-tokens"] ?? 2048),
    ...(target.thinking ? { reasoning_effort: target.thinking } : {}),
    messages: [{ role: "user", content: probePrompt(sim, agent) }],
    tools: toolSchemas(sim, agent),
  };
  const res = await fetch(`${target["base-url"].replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { name: setup.name, asks: setup.asks, seed, called: [], found: false, said: `HTTP ${res.status}`, arranged };
  }
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string } }> } }>;
  };
  const message = payload.choices?.[0]?.message;
  const called = (message?.tool_calls ?? []).map((c) => c.function?.name ?? "?").filter(Boolean);
  return {
    name: setup.name,
    asks: setup.asks,
    seed,
    called,
    found: called.some((c) => setup.wants.includes(c)),
    said: (message?.content ?? "").replace(/\s+/g, " ").slice(0, 140),
    arranged,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
  };
  const target = JSON.parse(
    readFileSync(new URL(`../targets/${flag("target", "ninfer-38")}.json`, import.meta.url), "utf8"),
  ) as Target;
  const samples = Number(flag("samples", "6"));
  const wanted = flag("probes", "").split(",").filter(Boolean);
  const chosen = PROBES.filter((p) => wanted.length === 0 || wanted.includes(p.name));

  console.log(`\n  ${chosen.length} probe(s) x ${samples} samples against ${target.model}\n`);
  for (const setup of chosen) {
    // Sequential on purpose: these share one GPU with whatever else is running,
    // and a probe that has to be scheduled around is a probe nobody runs.
    const results: ProbeResult[] = [];
    for (let i = 0; i < samples; i++) results.push(await askOnce(target, setup, 4000 + i));
    const hit = results.filter((r) => r.found).length;
    console.log(`  ${setup.name} — ${setup.asks}`);
    console.log(`    ${hit}/${samples} reached for ${setup.wants.join(" or ")}`);
    const others = new Map<string, number>();
    for (const r of results)
      for (const c of r.called) if (!setup.wants.includes(c)) others.set(c, (others.get(c) ?? 0) + 1);
    if (others.size) {
      console.log(
        `    instead: ${[...others.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}`,
      );
    }
    const quiet = results.filter((r) => r.called.length === 0);
    if (quiet.length) console.log(`    ${quiet.length} called nothing at all; one said: "${quiet[0].said}"`);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
