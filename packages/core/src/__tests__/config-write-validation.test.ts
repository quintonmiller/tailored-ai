import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { findUnknownKeys, normalizeRawConfig, validateConfig } from "../config.js";
import { type ConfigWriteHost, ConfigWriteRejected, updateRawConfig, writeRawConfigText } from "../config-write.js";

/**
 * The bug these cover: an agent wrote itself `name:` and `temp:` instead of
 * `temperature:`. Every layer accepted it and the agent ran at the default
 * temperature for a day. `validateConfig` had detected exactly this since
 * #252 — it just ran at startup, into a log, after the write.
 */

function makeHost(initialYaml: string): ConfigWriteHost & { reloads: number; read(): string } {
  const dir = mkdtempSync(join(tmpdir(), "tai-config-write-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, initialYaml, "utf-8");
  return {
    configPath,
    reloads: 0,
    read: () => readFileSync(configPath, "utf-8"),
    async withConfigLock<T>(fn: () => T | Promise<T>): Promise<T> {
      return fn();
    },
    reload() {
      this.reloads++;
    },
  };
}

const VALID = ["agents:", "  writer:", "    temperature: 0.3"].join("\n");

describe("updateRawConfig", () => {
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    host = makeHost(VALID);
  });

  it("writes a valid change and reloads", async () => {
    const result = await updateRawConfig(host, (raw) => {
      const agents = raw.agents as Record<string, Record<string, unknown>>;
      agents.writer.temperature = 0.9;
    });

    expect(YAML.parse(host.read()).agents.writer.temperature).toBe(0.9);
    expect(host.reloads).toBe(1);
    // The fixture is minimal enough to draw unrelated advisory warnings (no
    // defaultModel). Those are reported, never refused — what matters is that
    // the write introduced no unread keys.
    expect(result.warnings.some((w) => w.includes("unknown key"))).toBe(false);
  });

  it("refuses a key that parses but is never read, and leaves the file untouched", async () => {
    const before = host.read();

    await expect(
      updateRawConfig(host, (raw) => {
        const agents = raw.agents as Record<string, Record<string, unknown>>;
        agents.writer.temp = 0.3;
      }),
    ).rejects.toBeInstanceOf(ConfigWriteRejected);

    expect(host.read()).toBe(before);
    expect(host.reloads).toBe(0);
  });

  it("names the offending key and suggests the real one", async () => {
    const err = await updateRawConfig(host, (raw) => {
      const agents = raw.agents as Record<string, Record<string, unknown>>;
      agents.writer.temp = 0.3;
    }).catch((e) => e as ConfigWriteRejected);

    expect(err).toBeInstanceOf(ConfigWriteRejected);
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]).toContain('unknown key "temp"');
    expect(err.issues[0]).toContain('Did you mean "temperature"');
  });

  it("refuses an unknown key on a newly created agent", async () => {
    await expect(
      updateRawConfig(host, (raw) => {
        (raw.agents as Record<string, unknown>)["notion-manager"] = {
          description: "SME",
          name: "notion-manager",
          temp: 0.3,
        };
      }),
    ).rejects.toThrow(/unknown key/);
  });

  it("refuses an unknown top-level key", async () => {
    await expect(
      updateRawConfig(host, (raw) => {
        raw.agentz = {};
      }),
    ).rejects.toThrow(/unknown top-level key "agentz"/);
  });

  /**
   * The rule that keeps the gate from becoming a lockout. A deployment
   * accumulates findings unrelated to the next write; judging a write on the
   * total would make the config permanently unwritable for reasons that have
   * nothing to do with the change.
   */
  it("allows a valid write when an unrelated bad key already exists", async () => {
    const withExisting = makeHost(
      ["agents:", "  legacy:", "    system_prompt: old", "  writer:", "    temperature: 0.3"].join("\n"),
    );

    const result = await updateRawConfig(withExisting, (raw) => {
      const agents = raw.agents as Record<string, Record<string, unknown>>;
      agents.writer.temperature = 0.5;
    });

    expect(YAML.parse(withExisting.read()).agents.writer.temperature).toBe(0.5);
    // Reported, not refused — the caller can surface it.
    expect(result.warnings.some((w) => w.includes('unknown key "system_prompt"'))).toBe(true);
  });

  it("still refuses a new bad key when a pre-existing one is present", async () => {
    const withExisting = makeHost(
      ["agents:", "  legacy:", "    system_prompt: old", "  writer:", "    temperature: 0.3"].join("\n"),
    );

    const err = await updateRawConfig(withExisting, (raw) => {
      const agents = raw.agents as Record<string, Record<string, unknown>>;
      agents.writer.temp = 0.1;
    }).catch((e) => e as ConfigWriteRejected);

    expect(err).toBeInstanceOf(ConfigWriteRejected);
    // Only the introduced one — not the pre-existing legacy key.
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0]).toContain('unknown key "temp"');
  });

  /**
   * `readRawConfig` answers a parse failure with `{}`. A patch computed on top
   * of that writes the patch over an empty document and silently drops the
   * rest of the file.
   */
  it("refuses to patch a config it could not parse, rather than overwriting it", async () => {
    const broken = makeHost("agents:\n  writer:\n   bad: [unclosed\n");
    const before = broken.read();

    await expect(updateRawConfig(broken, (raw) => (raw.x = 1))).rejects.toBeInstanceOf(ConfigWriteRejected);

    expect(broken.read()).toBe(before);
    expect(broken.reloads).toBe(0);
  });
});

describe("writeRawConfigText", () => {
  /**
   * The route this replaces wrote the request body to disk unparsed. Because
   * reload() swallows its own failures, it answered 200 {"ok":true} while the
   * process kept serving the previous config.
   */
  it("refuses YAML that does not parse, and leaves the file untouched", async () => {
    const host = makeHost(VALID);
    const before = host.read();

    await expect(writeRawConfigText(host, "agents:\n  writer:\n   x: [unclosed\n")).rejects.toThrow(/not valid YAML/);

    expect(host.read()).toBe(before);
    expect(host.reloads).toBe(0);
  });

  it("refuses text that introduces an unread key", async () => {
    const host = makeHost(VALID);

    await expect(writeRawConfigText(host, ["agents:", "  writer:", "    temp: 0.3"].join("\n"))).rejects.toThrow(
      /unknown key "temp"/,
    );
  });

  it("writes valid replacement text and reloads", async () => {
    const host = makeHost(VALID);
    const next = ["agents:", "  writer:", "    temperature: 0.8"].join("\n");

    await writeRawConfigText(host, next);

    // Written verbatim: the raw editor's whole point is that what you typed is
    // what lands, comments and all.
    expect(host.read()).toBe(next);
    expect(host.reloads).toBe(1);
  });
});

describe("findUnknownKeys", () => {
  it("reports the same strings validateConfig does, so the two can be compared", () => {
    const config = normalizeRawConfig(
      YAML.parse(["agents:", "  writer:", "    temp: 0.3"].join("\n")) as Record<string, unknown>,
    );

    const unknown = findUnknownKeys(config);
    const all = validateConfig(config);

    expect(unknown.length).toBeGreaterThan(0);
    for (const issue of unknown) expect(all).toContain(issue);
  });

  it("says nothing about a config whose keys are all real", () => {
    const config = normalizeRawConfig(
      YAML.parse(["agents:", "  writer:", "    temperature: 0.3", "    instructions: hi"].join("\n")) as Record<
        string,
        unknown
      >,
    );

    expect(findUnknownKeys(config)).toEqual([]);
  });
});

/**
 * Found by adversarial review. `validateConfig` assumes the shapes
 * DEFAULT_CONFIG supplies, but a bare `agents:` parses as null and survives
 * deepMerge, so `Object.entries(null)` throws. Called unguarded after the
 * write, that reported a completed write as a failure — 500 from the HTTP
 * route, "Config not written" from the admin tool — while the file had
 * already been replaced and the runtime reloaded.
 */
describe("a config shape that breaks validateConfig", () => {
  const bare = ["agents:", "agent:", "  temperature: 0.4"].join("\n");

  it("does not report a completed write as a failed one", async () => {
    const host = makeHost(VALID);

    const result = await writeRawConfigText(host, bare);

    expect(host.read()).toBe(bare);
    expect(host.reloads).toBe(1);
    // Said out loud rather than thrown.
    expect(result.warnings.some((w) => w.includes("could not complete"))).toBe(true);
  });

  it("survives the same shape through a patch", async () => {
    const host = makeHost(bare);

    const result = await updateRawConfig(host, (raw) => {
      raw.server = { port: 3001 };
    });

    expect(YAML.parse(host.read()).server.port).toBe(3001);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
