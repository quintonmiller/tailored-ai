import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { HttpRequestExecutor } from "../workflows/executors/http-request.js";
import { WorkflowRegistry } from "../workflows/registry.js";

let db: Database.Database;
let registry: WorkflowRegistry;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
});

afterEach(() => {
  db.close();
});

function makeFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init ?? {}))) as unknown as typeof fetch;
}

function makeEngine(fetcher: typeof fetch): WorkflowEngine {
  return new WorkflowEngine({
    db,
    registry,
    executors: [new HttpRequestExecutor({ fetcher })],
  });
}

describe("HttpRequestExecutor", () => {
  it("GET parses JSON and exposes status/headers/body to downstream steps", async () => {
    const fetcher = makeFetch(async (url) => {
      expect(url).toBe("https://example.test/users/42");
      return new Response(JSON.stringify({ id: 42, name: "alice" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const engine = makeEngine(fetcher);
    registry.register({
      name: "wf",
      steps: [
        {
          name: "fetch_user",
          type: "http_request",
          url: "https://example.test/users/${input.id}",
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { id: 42 });
    expect(run.status).toBe("completed");
    const out = run.output as { status: number; body: { name: string } };
    expect(out.status).toBe(200);
    expect(out.body.name).toBe("alice");
  });

  it("POST encodes object body as JSON and sets content-type", async () => {
    const seen: { url: string; init: RequestInit } = { url: "", init: {} };
    const fetcher = makeFetch(async (url, init) => {
      seen.url = url;
      seen.init = init;
      return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
    });
    const engine = makeEngine(fetcher);
    registry.register({
      name: "wf",
      steps: [
        {
          name: "create",
          type: "http_request",
          method: "POST",
          url: "https://example.test/items",
          body: { name: "${input.name}", count: 3 },
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { name: "widget" });
    expect(run.status).toBe("completed");
    expect(seen.init.method).toBe("POST");
    const ct = (seen.init.headers as Record<string, string>)["Content-Type"];
    expect(ct).toBe("application/json");
    expect(JSON.parse(String(seen.init.body))).toEqual({ name: "widget", count: 3 });
  });

  it("templates header values from scope", async () => {
    const seen: Record<string, string> = {};
    const fetcher = makeFetch(async (_url, init) => {
      Object.assign(seen, init.headers as Record<string, string>);
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const engine = makeEngine(fetcher);
    registry.register({
      name: "wf",
      steps: [
        {
          name: "auth",
          type: "http_request",
          url: "https://example.test/",
          headers: { Authorization: "Bearer ${input.token}" },
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { token: "abc" });
    expect(run.status).toBe("completed");
    expect(seen.Authorization).toBe("Bearer abc");
  });

  it("non-2xx status fails the run with status + preview in the error", async () => {
    const fetcher = makeFetch(
      async () =>
        new Response('{"error":"nope"}', {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    );
    const engine = makeEngine(fetcher);
    registry.register({
      name: "wf",
      steps: [
        { name: "go", type: "http_request", url: "https://example.test/" },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/500/);
    expect(run.error).toMatch(/nope/);
  });

  it("expectStatus override accepts non-2xx as success", async () => {
    const fetcher = makeFetch(
      async () =>
        new Response("redirected", {
          status: 302,
          headers: { "content-type": "text/plain", location: "https://elsewhere" },
        }),
    );
    const engine = makeEngine(fetcher);
    registry.register({
      name: "wf",
      steps: [
        {
          name: "go",
          type: "http_request",
          url: "https://example.test/",
          expectStatus: [302],
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    const out = run.output as { status: number; headers: Record<string, string> };
    expect(out.status).toBe(302);
    expect(out.headers.location).toBe("https://elsewhere");
  });

  it("parseAs:text forces text parsing of JSON content-type", async () => {
    const fetcher = makeFetch(
      async () =>
        new Response('{"a":1}', { status: 200, headers: { "content-type": "application/json" } }),
    );
    const engine = makeEngine(fetcher);
    registry.register({
      name: "wf",
      steps: [
        {
          name: "go",
          type: "http_request",
          url: "https://example.test/",
          parseAs: "text",
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect((run.output as { body: unknown }).body).toBe('{"a":1}');
  });

  it("timeout aborts a slow request", async () => {
    const fetcher = (() => {
      return new Promise((_resolve, reject) => {
        // Reject when the supplied signal aborts.
        return Promise.resolve();
      });
    }) as unknown as typeof fetch;
    const slowFetcher: typeof fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig) sig.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    void fetcher;
    const engine = makeEngine(slowFetcher);
    registry.register({
      name: "wf",
      steps: [
        {
          name: "go",
          type: "http_request",
          url: "https://example.test/",
          timeoutMs: 50,
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/timed out/);
  });
});
