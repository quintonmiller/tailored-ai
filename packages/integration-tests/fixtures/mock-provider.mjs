#!/usr/bin/env node
// Deterministic OpenAI-compatible chat-completions server for the e2e tests.
//
// Why: we don't want CI gated on a real LLM (flaky, costs money, network).
// All scenarios that need a model talk to this server via the
// `openai_compatible` provider with base_url http://localhost:18080/v1.
//
// Behavior: returns canned content keyed off the last user message. Add new
// canned responses here when a scenario needs one.
//
// Logs every request to MOCK_PROVIDER_LOG (default /work/mock-provider.log)
// so scenarios can assert what TAI actually sent.

import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PORT = Number(process.env.MOCK_PROVIDER_PORT ?? 18080);
const LOG = process.env.MOCK_PROVIDER_LOG ?? "/work/mock-provider.log";

mkdirSync(dirname(LOG), { recursive: true });

// Keyed by a substring match against the last user message; first match wins.
// Add fixtures here as scenarios need them.
const RESPONSES = [
  { match: /ping/i, content: "pong" },
  { match: /smoke test/i, content: "ack" },
];
const DEFAULT_CONTENT = "ok";

function logEvent(event) {
  appendFileSync(LOG, `${JSON.stringify(event)}\n`);
}

function pickContent(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";
  const hit = RESPONSES.find((r) => r.match.test(text));
  return hit?.content ?? DEFAULT_CONTENT;
}

function chatCompletion(body) {
  const content = pickContent(body.messages ?? []);
  return {
    id: `mock-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? "mock-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, tool_calls: undefined },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      // tolerate non-JSON probes (e.g. health checks) — body stays {}
    }
    logEvent({ method: req.method, url: req.url, body });

    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url?.endsWith("/chat/completions")) {
      const resp = chatCompletion(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resp));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no fixture for ${req.method} ${req.url}` } }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-provider] listening on http://127.0.0.1:${PORT}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
