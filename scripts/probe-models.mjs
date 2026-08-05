#!/usr/bin/env node
/**
 * probe-models — measure what a cloud model actually does when TAI calls it.
 *
 *   node scripts/probe-models.mjs           one-shot tool call, run twice to see caching
 *   node scripts/probe-models.mjs --loop    multi-round loop with simulated tool results
 *
 * Reads OPENAI_API_KEY / DEEPSEEK_API_KEY / OPENROUTER_API_KEY from the
 * environment and silently skips any route whose key is missing. A full sweep
 * costs a few cents.
 *
 * Why this exists: published benchmarks do not tell you whether a model's
 * prompt cache actually engages on your traffic, whether its vendor rejects
 * function tools on the endpoint the provider plugin posts to, or how many
 * rounds it takes to finish a three-step job. All three have decided a model
 * choice here, and all three are one probe away. See docs/model-fallbacks.md.
 */

const LOOP = process.argv.includes("--loop");

const ENDPOINTS = {
  oa: { url: "https://api.openai.com/v1/chat/completions", key: process.env.OPENAI_API_KEY },
  ds: { url: "https://api.deepseek.com/chat/completions", key: process.env.DEEPSEEK_API_KEY },
  or: { url: "https://openrouter.ai/api/v1/chat/completions", key: process.env.OPENROUTER_API_KEY },
};

/** Candidates. `extra` carries whatever that vendor needs to accept tools at all. */
const CANDIDATES = [
  ["deepseek-v4-pro (think)", "ds", "deepseek-v4-pro", { thinking: { type: "enabled" } }],
  ["deepseek-v4-pro (nothink)", "ds", "deepseek-v4-pro", { thinking: { type: "disabled" } }],
  ["deepseek-v4-flash", "ds", "deepseek-v4-flash", { thinking: { type: "disabled" } }],
  // reasoning_effort:"none" is mandatory: the GPT-5.6 family rejects function
  // tools on /chat/completions at any other effort level.
  ["gpt-5.6-luna (effort=none)", "oa", "gpt-5.6-luna", { reasoning_effort: "none" }],
  ["gpt-5-mini", "oa", "gpt-5-mini", {}],
  ["OR qwen3.7-flash", "or", "qwen/qwen3.7-flash", {}],
  ["OR qwen3.7-plus", "or", "qwen/qwen3.7-plus", {}],
  ["OR glm-4.7-flash", "or", "z-ai/glm-4.7-flash", {}],
  ["OR minimax-m3", "or", "minimax/minimax-m3", {}],
  ["OR gemini-3.5-flash-lite", "or", "google/gemini-3.5-flash-lite", {}],
];

const tool = (name, description, props) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: props, required: Object.keys(props) } },
});

const TOOLS = [
  tool("exec", "Run an allowlisted shell command.", { command: { type: "string" } }),
  tool("room", "Post a message to a room.", { room: { type: "string" }, message: { type: "string" } }),
  tool("memory", "Append a note to memory.", { text: { type: "string" } }),
  tool("read", "Read a file.", { path: { type: "string" } }),
  tool("write", "Write a file.", { path: { type: "string" }, content: { type: "string" } }),
  tool("web_search", "Search the web.", { query: { type: "string" } }),
  tool("task_create", "Create a task.", { title: { type: "string" } }),
  tool("task_query", "Query tasks.", { status: { type: "string" } }),
  tool("delegate", "Delegate to another agent.", { agent: { type: "string" }, message: { type: "string" } }),
  tool("recall", "Recall from memory.", { query: { type: "string" } }),
];

// Padding to a realistic system-prompt size; caching needs >1k tokens to engage.
const SYSTEM =
  "You are an agent in a personal automation system. ".repeat(400) +
  "\nUse tools rather than describing what you would do." +
  (LOOP ? "\nWhen the task is fully done, reply with a one-line summary and no tool call." : "");

const ONE_SHOT = "Check the Notion page count with `ntn api v1/search -d '{\"page_size\":1}'` and report it. Start now.";
const THREE_STEP = `Do all three, in order:
1. Count Notion pages: exec \`ntn api v1/search -d '{"page_size":1}'\`
2. Post the count to the #general room.
3. Save a memory note recording the count.
Then summarise in one line.`;

/**
 * Simulated tool results. Deliberately unambiguous: an earlier version returned
 * `has_more: true` with no count, and three models kept re-calling `exec` rather
 * than moving on. That measures recovery from ambiguity, which is a real signal
 * but a different question — keep the fixtures clean unless that is what you are
 * testing, or you will report working models as broken.
 */
function fakeResult(name) {
  if (name === "exec")
    return JSON.stringify({ object: "list", results: [{ id: "a1b2", object: "page" }], has_more: false, total_count: 247 });
  if (name === "room") return "Posted to #general.";
  if (name === "memory") return "Note saved (id: note_8812).";
  return `${name} ok`;
}

function usageOf(u = {}) {
  return {
    in: u.prompt_tokens ?? 0,
    out: u.completion_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

async function call(host, model, messages, extra) {
  const { url, key } = ENDPOINTS[host];
  const body = { model, messages, tools: TOOLS, ...extra };
  // max_tokens is rejected by the gpt-5 family; max_completion_tokens is
  // rejected by some OpenAI-compatible gateways. Send the one that fits.
  if (host === "oa") body.max_completion_tokens = 4096;
  else body.max_tokens = 4096;

  const started = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  return { ok: resp.ok, status: resp.status, json, ms: Date.now() - started };
}

async function oneShot(label, host, model, extra) {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: ONE_SHOT },
  ];
  let r;
  try {
    r = await call(host, model, messages, extra);
  } catch (err) {
    console.log(`${label.padEnd(30)} NETWORK ${err.message.slice(0, 60)}`);
    return;
  }
  if (!r.ok) {
    console.log(`${label.padEnd(30)} HTTP ${r.status}: ${String(r.json.error?.message ?? "").slice(0, 100)}`);
    return;
  }
  const calls = r.json.choices?.[0]?.message?.tool_calls ?? [];
  const name = calls[0]?.function?.name ?? "(none)";
  let command = "";
  try {
    command = JSON.parse(calls[0]?.function?.arguments ?? "{}").command ?? "";
  } catch {
    command = "(unparseable)";
  }
  const verdict = name === "exec" && /ntn api/.test(command) ? "ok" : name === "(none)" ? "NO-CALL" : `~${name}`;
  const u = usageOf(r.json.usage);
  console.log(
    `${label.padEnd(30)} ${`${r.ms}ms`.padStart(7)} ${verdict.padEnd(8)}` +
      ` in=${String(u.in).padStart(5)} cached=${String(u.cached).padStart(5)}` +
      ` out=${String(u.out).padStart(4)} reasoning=${u.reasoning}`,
  );
}

async function loop(label, host, model, extra, maxRounds = 8) {
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: THREE_STEP },
  ];
  const seq = [];
  let totalIn = 0;
  let totalCached = 0;
  let totalOut = 0;
  let totalMs = 0;
  let outcome = `hit ${maxRounds}-round cap`;

  for (let round = 1; round <= maxRounds; round++) {
    let r;
    try {
      r = await call(host, model, messages, extra);
    } catch (err) {
      outcome = `network: ${err.message.slice(0, 30)}`;
      break;
    }
    totalMs += r.ms;
    if (!r.ok) {
      outcome = `HTTP ${r.status}: ${String(r.json.error?.message ?? "").slice(0, 60)}`;
      break;
    }
    const message = r.json.choices?.[0]?.message ?? {};
    const u = usageOf(r.json.usage);
    totalIn += u.in;
    totalOut += u.out;
    totalCached += u.cached;

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      seq.push("TEXT");
      outcome = `done@${round}`;
      break;
    }
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const c of calls) {
      seq.push(c.function.name);
      messages.push({ role: "tool", tool_call_id: c.id, content: fakeResult(c.function.name) });
    }
  }

  const hit = totalIn ? `${Math.round((100 * totalCached) / totalIn)}%` : "0%";
  console.log(
    `${label.padEnd(30)} ${outcome.padEnd(14)} ${`${(totalMs / 1000).toFixed(1)}s`.padStart(7)}` +
      ` in=${String(totalIn).padStart(6)} cache=${hit.padStart(4)} out=${String(totalOut).padStart(5)} | ${seq.join(">")}`,
  );
}

const runnable = CANDIDATES.filter(([, host]) => ENDPOINTS[host].key);
const skipped = CANDIDATES.length - runnable.length;
if (runnable.length === 0) {
  console.error("No API keys in the environment (OPENAI_API_KEY / DEEPSEEK_API_KEY / OPENROUTER_API_KEY).");
  process.exit(1);
}
if (skipped > 0) console.log(`(skipping ${skipped} candidate(s) with no key configured)\n`);

if (LOOP) {
  console.log(`${"model".padEnd(30)} ${"outcome".padEnd(14)} ${"wall".padStart(7)}  input cache   out | tool sequence`);
  for (const [label, host, model, extra] of runnable) await loop(label, host, model, extra);
} else {
  // Twice: the second pass is where prompt caching shows up, and where a
  // vendor that advertises caching but never engages it becomes visible.
  for (const pass of [1, 2]) {
    console.log(`\n--- pass ${pass} ---`);
    for (const [label, host, model, extra] of runnable) await oneShot(label, host, model, extra);
  }
}
