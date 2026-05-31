#!/usr/bin/env node
// Flexibility probe: drive the Phase 1 mediator against real public sites.
// Read-only scenarios only — no form submissions, no logins, no purchases.
//
// Usage:
//   node scripts/e2e-mediator-external.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BrowserMediatorTool,
  OpenAIProvider,
  initDatabase,
  newSession,
  runAgentLoop,
} from "../packages/core/dist/index.js";

const VLLM_BASE = "http://127.0.0.1:8000/v1";
const VLLM_MODEL = "qwen3.6-27b-vllm";

function banner(s) {
  console.log("\n" + "═".repeat(72));
  console.log(s);
  console.log("═".repeat(72));
}

function shortenResult(r, max = 200) {
  return r.length > max ? r.slice(0, max) + "…" : r;
}

async function runScenario({ name, task, allow, provider, db, expect }) {
  banner(`SCENARIO: ${name}`);
  console.log(`Task: ${task}`);
  console.log(`Allow-list: ${allow.join(", ")}`);
  const tool = new BrowserMediatorTool({
    enabled: true,
    headless: true,
    timeoutMs: 25_000,
    egressAllowList: allow,
  });
  const session = newSession(db, VLLM_MODEL, "openai_compatible");
  const toolCalls = [];
  const toolResults = [];
  const t0 = Date.now();
  let finalOut = "";
  let loopErr = null;
  try {
    finalOut = await runAgentLoop(task, {
      provider,
      session,
      db,
      tools: [tool],
      extraInstructions:
        "You have one tool: `browser_mediator`. Call it with action=navigate(url), action=read_text, " +
        "action=read_links, action=click({node_id|text}), or action=type_text({node_id, value}). " +
        "Use read_text first to see what's on the page. Do not invent content you did not read. " +
        "When you have an answer, return a short final message (1-3 sentences).",
      maxToolRounds: 6,
      maxHistoryTokens: 10_000,
      temperature: 0.2,
      nudgeOnText: 1,
      onToolCall: (n, args) => {
        toolCalls.push({ name: n, args });
        console.log(`  → ${n}(${JSON.stringify(args).slice(0, 200)})`);
      },
      onToolResult: (n, r) => {
        toolResults.push({ name: n, result: r });
        console.log(`  ← ${shortenResult(r)}`);
      },
    });
  } catch (err) {
    loopErr = err.message;
    console.error(`Loop error: ${err.message}`);
  } finally {
    await tool.execute(
      { action: "close" },
      { sessionId: "e2e", workingDirectory: "/tmp", env: {} },
    );
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nFinal: ${finalOut.slice(0, 300)}${finalOut.length > 300 ? "…" : ""}`);
  console.log(`Elapsed: ${elapsed}s  Tool rounds: ${toolCalls.length}`);
  // Run scenario-specific assertions
  const checks = expect({ toolCalls, toolResults, finalOut, loopErr });
  return { name, checks, elapsed, toolCalls, toolResults, finalOut };
}

function check(label, pass) {
  console.log(`  ${pass ? "✓" : "✗"} ${label}`);
  return pass;
}

function any(rs, re) {
  return rs.some((x) => re.test(x.result));
}

async function main() {
  const provider = new OpenAIProvider(undefined, VLLM_BASE, {
    id: "openai_compatible",
    name: "vLLM",
  });
  const dbDir = mkdtempSync(join(tmpdir(), "tai-e2e-ext-"));
  const db = initDatabase(join(dbDir, "agent.db"));

  const scenarios = [
    {
      name: "A — example.com (the canonical test page)",
      task:
        "Use browser_mediator to open https://example.com and tell me the first H1 heading on the page.",
      allow: ["example.com", "example.org", "iana.org"],
      expect: ({ toolCalls, toolResults, finalOut }) => {
        let pass = 0;
        pass += check("agent called navigate", toolCalls.some((c) => c.args.action === "navigate")) ? 1 : 0;
        pass += check("agent called read_text", toolCalls.some((c) => c.args.action === "read_text")) ? 1 : 0;
        pass += check("read_text returned 'Example Domain'", any(toolResults, /Example Domain/)) ? 1 : 0;
        pass += check("final message mentions Example Domain", /Example Domain/i.test(finalOut)) ? 1 : 0;
        return pass;
      },
    },
    {
      name: "B — Wikipedia article (read article body)",
      task:
        "Use browser_mediator to open https://en.wikipedia.org/wiki/Playwright_(software) and tell me, in one sentence, what Playwright is according to the opening paragraph.",
      allow: ["wikipedia.org", "wikimedia.org"],
      expect: ({ toolResults, finalOut }) => {
        let pass = 0;
        pass += check("page text mentions Microsoft or browser automation", any(toolResults, /Microsoft|browser|automation|testing/i)) ? 1 : 0;
        pass += check("final message names Playwright as automation/test tool", /(automation|test|browser)/i.test(finalOut)) ? 1 : 0;
        return pass;
      },
    },
    {
      name: "C — Hacker News (read links from a real list page)",
      task:
        "Use browser_mediator to open https://news.ycombinator.com and use read_links to give me the text of any 3 story titles. Just list them.",
      allow: ["ycombinator.com"],
      expect: ({ toolCalls, toolResults, finalOut }) => {
        let pass = 0;
        pass += check("agent called read_links", toolCalls.some((c) => c.args.action === "read_links")) ? 1 : 0;
        pass += check("at least one el:bm: opaque id returned", any(toolResults, /el:bm-[0-9a-f]+:\d+/)) ? 1 : 0;
        pass += check("final message lists multiple items (non-empty)", finalOut.trim().length > 30) ? 1 : 0;
        return pass;
      },
    },
    {
      name: "D — GitHub public repo (read a README/heading)",
      task:
        "Use browser_mediator to open https://github.com/microsoft/playwright and tell me the short description of the repo (one sentence).",
      allow: ["github.com", "githubusercontent.com"],
      expect: ({ toolResults, finalOut }) => {
        let pass = 0;
        pass += check("agent saw repo content (Playwright text on page)", any(toolResults, /Playwright/i)) ? 1 : 0;
        pass += check("final message mentions browser/automation/testing", /(browser|automation|test|web)/i.test(finalOut)) ? 1 : 0;
        return pass;
      },
    },
    {
      name: "E — egress sanity: googling without google in allow-list",
      task: "Use browser_mediator to open https://www.google.com/search?q=hello and read it.",
      allow: ["example.com"], // intentionally wrong host
      expect: ({ toolResults }) => {
        let pass = 0;
        pass += check("mediator refused (host not on allow-list)", any(toolResults, /allow-list|Refusing|EgressBlocked/i)) ? 1 : 0;
        return pass;
      },
    },
  ];

  const results = [];
  let totalPass = 0;
  let totalChecks = 0;
  for (const s of scenarios) {
    const r = await runScenario({ ...s, provider, db });
    results.push(r);
    totalChecks += scenarioMaxChecks(s.name);
    totalPass += r.checks;
  }

  banner("SUMMARY");
  for (const r of results) {
    console.log(`${r.name.padEnd(50)} ${r.checks} pass  ${r.elapsed}s  ${r.toolCalls.length} rounds`);
  }
  console.log(`\nTotal: ${totalPass}/${totalChecks} scenario-level checks passed.`);

  db.close();
  rmSync(dbDir, { recursive: true, force: true });
  process.exit(0);
}

function scenarioMaxChecks(name) {
  if (name.startsWith("A")) return 4;
  if (name.startsWith("B")) return 2;
  if (name.startsWith("C")) return 3;
  if (name.startsWith("D")) return 2;
  if (name.startsWith("E")) return 1;
  return 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
