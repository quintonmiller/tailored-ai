import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_TOKEN_ENV_VAR, mergeEnvLines, resolveHeadlessDraft, runHeadlessInit } from "../setup-headless.js";

/** Env vars resolveHeadlessDraft consults; cleared between tests so a value
 * leaking in from the developer's own shell can't decide an assertion. */
const ENV_KEYS = [
  "TAI_PROVIDER",
  "TAI_MODEL",
  "TAI_BASE_URL",
  "TAI_API_KEY",
  "TAI_SERVER_HOST",
  "TAI_SERVER_PORT",
  AUTH_TOKEN_ENV_VAR,
];

let saved: Record<string, string | undefined> = {};
let home: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), "tai-headless-"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("resolveHeadlessDraft", () => {
  it("refuses to guess a model", () => {
    expect(() => resolveHeadlessDraft({ homeDir: home })).toThrow(/No model specified/);
  });

  it("reads every field from the environment when no flag is passed", () => {
    process.env.TAI_MODEL = "from-env";
    process.env.TAI_BASE_URL = "http://gateway:8000/v1";
    process.env.TAI_SERVER_PORT = "4100";
    const { draft, server } = resolveHeadlessDraft({ homeDir: home });
    expect(draft.provider.defaultModel).toBe("from-env");
    expect(draft.provider.baseUrl).toBe("http://gateway:8000/v1");
    expect(server.port).toBe(4100);
  });

  it("prefers an explicit flag over the environment", () => {
    process.env.TAI_MODEL = "from-env";
    const { draft } = resolveHeadlessDraft({ homeDir: home, model: "from-flag" });
    expect(draft.provider.defaultModel).toBe("from-flag");
  });

  it("treats a blank env var as unset rather than as an empty answer", () => {
    process.env.TAI_MODEL = "";
    expect(() => resolveHeadlessDraft({ homeDir: home })).toThrow(/No model specified/);
  });

  it("rejects a non-numeric port instead of parseInt-ing a prefix out of it", () => {
    expect(() => resolveHeadlessDraft({ homeDir: home, model: "m", port: "3000abc" })).toThrow(/Invalid port/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => resolveHeadlessDraft({ homeDir: home, model: "m", port: 70000 })).toThrow(/Invalid port/);
  });

  it("leaves a loopback bind without a token", () => {
    const { authToken, generated } = resolveHeadlessDraft({ homeDir: home, model: "m" });
    expect(authToken).toBeUndefined();
    expect(generated).toBe(false);
  });

  it("mints a token when the bind is not loopback", () => {
    const { authToken, generated, server } = resolveHeadlessDraft({ homeDir: home, model: "m", host: "0.0.0.0" });
    expect(generated).toBe(true);
    expect(authToken).toHaveLength(43); // 32 random bytes, base64url
    expect(server.authTokenEnvVar).toBe(AUTH_TOKEN_ENV_VAR);
  });

  it("uses a supplied token rather than minting one", () => {
    const { authToken, generated } = resolveHeadlessDraft({
      homeDir: home,
      model: "m",
      host: "0.0.0.0",
      authToken: "supplied",
    });
    expect(authToken).toBe("supplied");
    expect(generated).toBe(false);
  });

  it("honours an existing token in the environment across restarts", () => {
    process.env[AUTH_TOKEN_ENV_VAR] = "already-set";
    const { authToken, generated } = resolveHeadlessDraft({ homeDir: home, model: "m", host: "0.0.0.0" });
    expect(authToken).toBe("already-set");
    expect(generated).toBe(false);
  });

  it("suppresses token generation when auth is handled in front of TAI", () => {
    const { authToken, server } = resolveHeadlessDraft({
      homeDir: home,
      model: "m",
      host: "0.0.0.0",
      authToken: false,
    });
    expect(authToken).toBeUndefined();
    expect(server.authTokenEnvVar).toBeUndefined();
  });

  it("drops the Ollama base URL for a hosted provider that brings its own endpoint", () => {
    const { draft } = resolveHeadlessDraft({ homeDir: home, model: "claude-haiku-4-5", provider: "anthropic" });
    expect(draft.provider.baseUrl).toBeUndefined();
  });
});

describe("mergeEnvLines", () => {
  it("appends a key that is not present", () => {
    const { text, added } = mergeEnvLines("EXISTING=1\n", ["NEW=2"]);
    expect(text).toBe("EXISTING=1\nNEW=2\n");
    expect(added).toEqual(["NEW=2"]);
  });

  it("does not re-add a key that is already set", () => {
    // dotenv keeps the FIRST occurrence, so a duplicate would pin the stale
    // value while the operator reads the new one off the end of the file.
    const { text, added } = mergeEnvLines("TAI_AUTH_TOKEN=old\n", ["TAI_AUTH_TOKEN=new"]);
    expect(text).toBe("TAI_AUTH_TOKEN=old\n");
    expect(added).toEqual([]);
  });

  it("ignores commented-out keys when deciding what is present", () => {
    const { added } = mergeEnvLines("# TAI_AUTH_TOKEN=old\n", ["TAI_AUTH_TOKEN=new"]);
    expect(added).toEqual(["TAI_AUTH_TOKEN=new"]);
  });

  it("inserts a separator when the file does not end in a newline", () => {
    const { text } = mergeEnvLines("A=1", ["B=2"]);
    expect(text).toBe("A=1\nB=2\n");
  });
});

describe("runHeadlessInit", () => {
  it("writes a config that names the model and bind", async () => {
    const res = await runHeadlessInit({ homeDir: home, model: "qwen3", host: "0.0.0.0", port: 3000 });
    const yaml = readFileSync(res.configPath, "utf-8");
    expect(yaml).toContain("host: 0.0.0.0");
    expect(yaml).toContain("defaultModel: qwen3");
    expect(yaml).toContain(`authToken: \${${AUTH_TOKEN_ENV_VAR}}`);
  });

  it("keeps the secret out of config.yaml and puts it in .env", async () => {
    const res = await runHeadlessInit({ homeDir: home, model: "m", host: "0.0.0.0" });
    const yaml = readFileSync(res.configPath, "utf-8");
    expect(res.generatedAuthToken).toBeTruthy();
    expect(yaml).not.toContain(res.generatedAuthToken!);
    expect(readFileSync(res.envPath, "utf-8")).toContain(`${AUTH_TOKEN_ENV_VAR}=${res.generatedAuthToken}`);
  });

  it("refuses to clobber an existing config without --force", async () => {
    await runHeadlessInit({ homeDir: home, model: "first" });
    await expect(runHeadlessInit({ homeDir: home, model: "second" })).rejects.toThrow(/already exists/);
  });

  it("overwrites with force", async () => {
    const res = await runHeadlessInit({ homeDir: home, model: "first" });
    const again = await runHeadlessInit({ homeDir: home, model: "second", force: true });
    expect(again.overwrote).toBe(true);
    expect(readFileSync(res.configPath, "utf-8")).toContain("defaultModel: second");
  });

  it("does not mint a second token when .env already carries one", async () => {
    writeFileSync(join(home, ".env"), `${AUTH_TOKEN_ENV_VAR}=preexisting\n`);
    const res = await runHeadlessInit({ homeDir: home, model: "m", host: "0.0.0.0" });
    const env = readFileSync(res.envPath, "utf-8");
    expect(env.match(new RegExp(`${AUTH_TOKEN_ENV_VAR}=`, "g"))).toHaveLength(1);
    expect(env).toContain("preexisting");
  });

  it("writes nothing on a dry run", async () => {
    const res = await runHeadlessInit({ homeDir: home, model: "m", dryRun: true });
    expect(() => readFileSync(res.configPath, "utf-8")).toThrow();
  });

  it("turns off the bundled UI when asked", async () => {
    const res = await runHeadlessInit({ homeDir: home, model: "m", ui: false });
    expect(readFileSync(res.configPath, "utf-8")).toContain("enabled: false");
  });
});

// The point of headless init is an unattended first boot. A config that writes
// cleanly but fails to load, or loads with a security warning, would surface
// as a container crash-loop with the real cause buried in startup logs — so
// run the generated file through core's actual loader here.
describe("generated config survives a real load", () => {
  it("loads and validates without warnings on a loopback bind", async () => {
    const { loadConfig, validateConfig } = await import("@tailored-ai/core");
    const res = await runHeadlessInit({ homeDir: home, model: "qwen3", baseUrl: "http://localhost:11434/v1" });
    const cfg = loadConfig(res.configPath);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.server.port).toBe(3000);
    expect(cfg.agent.defaultProvider).toBe("openai_compatible");
    expect(validateConfig(cfg)).toEqual([]);
  });

  it("resolves the auth token through env interpolation on an exposed bind", async () => {
    const { loadConfig, validateConfig } = await import("@tailored-ai/core");
    const res = await runHeadlessInit({ homeDir: home, model: "m", host: "0.0.0.0" });
    // The container's entrypoint exports .env before starting the server;
    // emulate that so `authToken: ${TAI_AUTH_TOKEN}` resolves.
    process.env[AUTH_TOKEN_ENV_VAR] = res.generatedAuthToken!;
    const cfg = loadConfig(res.configPath);
    expect(cfg.server.authToken).toBe(res.generatedAuthToken);
    // No exposure warning: the bind is open but the token is real.
    expect(validateConfig(cfg).filter((w) => w.includes("server.host"))).toEqual([]);
  });

  it("warns about the exposed bind when the token env var never made it in", async () => {
    const { loadConfig, validateConfig } = await import("@tailored-ai/core");
    const res = await runHeadlessInit({ homeDir: home, model: "m", host: "0.0.0.0" });
    // `${TAI_AUTH_TOKEN}` interpolates to "" when unset, which is falsy — the
    // config looks authenticated but is not. The warning has to fire.
    delete process.env[AUTH_TOKEN_ENV_VAR];
    const cfg = loadConfig(res.configPath);
    expect(cfg.server.authToken).toBe("");
    expect(validateConfig(cfg).some((w) => w.includes("server.host"))).toBe(true);
  });
});
