import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase } from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createSessionToken, hasValidProxyAuth, LoginThrottle, verifyPassword } from "../auth/proxy-auth.js";
import { createServer, isHttps } from "../index.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({ content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" }),
  };
}

function buildConfig(serverOverrides: Partial<AgentConfig["server"]>): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1", ...serverOverrides },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "x", defaultModel: "fake" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 100,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: 1,
    },
    agents: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
  };
}

let db: ReturnType<typeof initDatabase>;
let tmpDir: string;
let originalCwd: string;
let originalHome: string | undefined;

function bootApp(cfg: AgentConfig) {
  const configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, YAML.stringify({}), "utf-8");
  const runtime = new AgentRuntime(
    {
      configPath,
      db,
      contextDir: join(tmpDir, "context"),
      kbDir: join(tmpDir, "kb"),
      createTools: () => [],
      createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
    },
    () => cfg,
    cfg,
  );
  return createServer({ runtime }).app;
}

type App = ReturnType<typeof bootApp>;

async function call(app: App, method: string, path: string, init: RequestInit = {}) {
  const res = await app.fetch(new Request(`http://t${path}`, { method, ...init }));
  return { status: res.status, text: await res.text(), headers: res.headers };
}

async function login(app: App, password: string, headers: Record<string, string> = {}) {
  return call(app, "POST", "/api/auth/login", {
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
}

/** Pull the session cookie out of a login response's Set-Cookie. */
function sessionCookie(headers: Headers): string | undefined {
  const raw = headers.get("set-cookie");
  return raw?.split(";")[0];
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "proxy-auth-"));
  process.env.HOME = tmpDir;
  process.chdir(tmpDir);
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

const ENABLED = { proxyAuth: { enabled: true, password: "hunter2" } };

describe("proxyAuth gate", () => {
  it("blocks reads, which is the entire point", async () => {
    // authToken already gated GETs. What proxyAuth adds is a credential a
    // BROWSER can carry, so verify the gate first.
    const app = bootApp(buildConfig(ENABLED));
    expect((await call(app, "GET", "/api/health")).status).toBe(401);
  });

  it("accepts the password as a bearer, for scripts", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const r = await call(app, "GET", "/api/health", { headers: { Authorization: "Bearer hunter2" } });
    expect(r.status).toBe(200);
  });

  it("rejects a wrong bearer", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const r = await call(app, "GET", "/api/health", { headers: { Authorization: "Bearer nope" } });
    expect(r.status).toBe(401);
  });

  it("leaves everything open when not enabled", async () => {
    const app = bootApp(buildConfig({}));
    expect((await call(app, "GET", "/api/health")).status).toBe(200);
  });

  it("fails closed when enabled with no password", async () => {
    // The dangerous failure would be degrading to an open API while still
    // reading as protected.
    const app = bootApp(buildConfig({ proxyAuth: { enabled: true, password: "" } }));
    const r = await call(app, "GET", "/api/health");
    expect(r.status).toBe(500);
    expect(r.text).toMatch(/password is empty/);
  });

  it("still honours authToken so scripts and browsers can coexist", async () => {
    const app = bootApp(buildConfig({ ...ENABLED, authToken: "script-token" }));
    const viaToken = await call(app, "GET", "/api/health", { headers: { Authorization: "Bearer script-token" } });
    expect(viaToken.status).toBe(200);
    const viaPassword = await call(app, "GET", "/api/health", { headers: { Authorization: "Bearer hunter2" } });
    expect(viaPassword.status).toBe(200);
  });
});

describe("POST /api/auth/login", () => {
  it("is reachable without a session, or nobody could ever get one", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const r = await login(app, "wrong");
    expect(r.status).toBe(401); // reached the handler, not the gate
  });

  it("mints a session cookie for the right password", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const r = await login(app, "hunter2");
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/tai_session=/);
  });

  it("marks the cookie HttpOnly so scripts on the page cannot read it", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const r = await login(app, "hunter2");
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  it("sets SameSite=Lax against cross-site request forgery", async () => {
    const app = bootApp(buildConfig(ENABLED));
    expect((await login(app, "hunter2")).headers.get("set-cookie")).toMatch(/SameSite=Lax/i);
  });

  it("does not mark the cookie Secure over plain HTTP", async () => {
    // A Secure cookie delivered over HTTP is dropped by the browser, so login
    // would appear to succeed and then not work at all on a LAN deployment.
    const app = bootApp(buildConfig(ENABLED));
    expect((await login(app, "hunter2")).headers.get("set-cookie")).not.toMatch(/Secure/i);
  });

  it("marks the cookie Secure behind a TLS-terminating proxy", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const r = await login(app, "hunter2", { "x-forwarded-proto": "https" });
    expect(r.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("the minted cookie actually opens the gate", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const cookie = sessionCookie((await login(app, "hunter2")).headers);
    expect(cookie).toBeTruthy();
    const r = await call(app, "GET", "/api/health", { headers: { Cookie: cookie as string } });
    expect(r.status).toBe(200);
  });

  it("rejects a forged cookie", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const r = await call(app, "GET", "/api/health", {
      headers: { Cookie: "tai_session=9999999999.deadbeef" },
    });
    expect(r.status).toBe(401);
  });

  it("treats a malformed body as a failed attempt, not a 400", async () => {
    // Otherwise garbage is a cheaper probe than a real guess.
    const app = bootApp(buildConfig(ENABLED));
    const r = await call(app, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(r.status).toBe(401);
  });

  it("404s when proxyAuth is off, so the UI can tell it is not in use", async () => {
    const app = bootApp(buildConfig({}));
    expect((await login(app, "anything")).status).toBe(404);
  });

  it("throttles repeated failures", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const ip = { "x-forwarded-for": "203.0.113.7" };
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await login(app, "wrong", ip)).status;
    expect(last).toBe(429);
  });

  it("throttles per client, not globally", async () => {
    // A shared counter would let one attacker lock out everyone else.
    const app = bootApp(buildConfig(ENABLED));
    for (let i = 0; i < 12; i++) await login(app, "wrong", { "x-forwarded-for": "203.0.113.7" });
    const other = await login(app, "hunter2", { "x-forwarded-for": "198.51.100.4" });
    expect(other.status).toBe(200);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const app = bootApp(buildConfig(ENABLED));
    const r = await call(app, "POST", "/api/auth/logout");
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/tai_session=;|Max-Age=0/i);
  });

  it("is reachable without a valid session", async () => {
    // Logging out of an expired session must not require the session.
    const app = bootApp(buildConfig(ENABLED));
    expect((await call(app, "POST", "/api/auth/logout")).status).toBe(200);
  });
});

describe("session tokens", () => {
  it("verifies a freshly minted token", () => {
    const { token } = createSessionToken("pw");
    expect(hasValidProxyAuth({ enabled: true, password: "pw" }, { bearer: "", cookie: token })).toBe(true);
  });

  it("rejects a token signed with a different password", () => {
    // Rotating the password must invalidate every issued session.
    const { token } = createSessionToken("old-password");
    expect(hasValidProxyAuth({ enabled: true, password: "new-password" }, { bearer: "", cookie: token })).toBe(false);
  });

  it("rejects an expired token", () => {
    const { token } = createSessionToken("pw", -1);
    expect(hasValidProxyAuth({ enabled: true, password: "pw" }, { bearer: "", cookie: token })).toBe(false);
  });

  it("rejects a token whose expiry was tampered with", () => {
    const { token } = createSessionToken("pw", 60);
    const sig = token.slice(token.indexOf(".") + 1);
    const forged = `${Math.floor(Date.now() / 1000) + 99999}.${sig}`;
    expect(hasValidProxyAuth({ enabled: true, password: "pw" }, { bearer: "", cookie: forged })).toBe(false);
  });

  it("rejects garbage", () => {
    for (const junk of ["", ".", "abc", "abc.def", "..", "1.2.3"]) {
      expect(hasValidProxyAuth({ enabled: true, password: "pw" }, { bearer: "", cookie: junk })).toBe(false);
    }
  });

  it("never authenticates against an empty password", () => {
    expect(hasValidProxyAuth({ enabled: true, password: "" }, { bearer: "", cookie: "x" })).toBe(false);
    expect(verifyPassword({ enabled: true, password: "" }, "")).toBe(false);
  });
});

describe("LoginThrottle", () => {
  it("allows attempts up to the limit", () => {
    const t = new LoginThrottle(3, 1000);
    for (let i = 0; i < 3; i++) {
      expect(t.retryAfter("ip")).toBe(0);
      t.recordFailure("ip");
    }
    expect(t.retryAfter("ip")).toBeGreaterThan(0);
  });

  it("forgets the record after the window passes", () => {
    const t = new LoginThrottle(1, 1000);
    t.recordFailure("ip", 0);
    expect(t.retryAfter("ip", 500)).toBeGreaterThan(0);
    expect(t.retryAfter("ip", 1500)).toBe(0);
  });

  it("clears the record on success, so one bad day is not a lockout", () => {
    const t = new LoginThrottle(2, 60_000);
    t.recordFailure("ip");
    t.recordSuccess("ip");
    t.recordFailure("ip");
    expect(t.retryAfter("ip")).toBe(0);
  });
});

describe("isHttps", () => {
  it("trusts x-forwarded-proto from a terminating proxy", () => {
    expect(isHttps("https", "http://internal/api")).toBe(true);
    expect(isHttps("http", "https://internal/api")).toBe(false);
  });

  it("reads the first value of a comma-joined chain", () => {
    expect(isHttps("https, http", "http://x/")).toBe(true);
  });

  it("falls back to the request URL when the header is absent", () => {
    expect(isHttps(undefined, "https://x/api")).toBe(true);
    expect(isHttps(undefined, "http://x/api")).toBe(false);
  });

  it("decides 'not TLS' on an unparseable URL", () => {
    // The safe direction: a missing Secure flag costs a hardening bit, a
    // wrongly-set one silently breaks login.
    expect(isHttps(undefined, "not a url")).toBe(false);
  });
});
