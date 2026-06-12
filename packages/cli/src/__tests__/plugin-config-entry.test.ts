import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addPluginsToConfig, removePluginsFromConfig } from "../plugins/config-entry.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tai-plugin-config-"));
  configPath = join(dir, "config.yaml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(yaml: string): void {
  writeFileSync(configPath, yaml, "utf8");
}

function pluginsList(): unknown[] {
  return (parse(readFileSync(configPath, "utf8")) as { plugins?: unknown[] }).plugins ?? [];
}

describe("addPluginsToConfig", () => {
  it("appends to an existing plugins list", () => {
    write("plugins:\n  - existing-plugin\n");
    const res = addPluginsToConfig(configPath, ["@tailored-ai/provider-bedrock"]);
    expect(res.changed).toEqual(["@tailored-ai/provider-bedrock"]);
    expect(pluginsList()).toEqual(["existing-plugin", "@tailored-ai/provider-bedrock"]);
  });

  it("creates the plugins key when missing", () => {
    write("agent:\n  defaultProvider: openai\n");
    const res = addPluginsToConfig(configPath, ["my-plugin"]);
    expect(res.changed).toEqual(["my-plugin"]);
    expect(pluginsList()).toEqual(["my-plugin"]);
  });

  it("replaces a null plugins key (plugins:)", () => {
    write("plugins:\n");
    const res = addPluginsToConfig(configPath, ["my-plugin"]);
    expect(res.changed).toEqual(["my-plugin"]);
    expect(pluginsList()).toEqual(["my-plugin"]);
  });

  it("is idempotent for bare-string and module-object entries", () => {
    write('plugins:\n  - "my-plugin"\n  - module: "other-plugin"\n    enabled: false\n');
    const res = addPluginsToConfig(configPath, ["my-plugin", "other-plugin", "new-plugin"]);
    expect(res.changed).toEqual(["new-plugin"]);
    expect(res.unchanged).toEqual(["my-plugin", "other-plugin"]);
    expect(pluginsList()).toHaveLength(3);
  });

  it("preserves comments elsewhere in the file", () => {
    write("# keep me\nplugins:\n  - existing # inline note\nagent:\n  defaultProvider: openai # and me\n");
    addPluginsToConfig(configPath, ["new-plugin"]);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain("# inline note");
    expect(text).toContain("# and me");
  });

  it("no-ops when the config file does not exist", () => {
    const res = addPluginsToConfig(join(dir, "missing.yaml"), ["my-plugin"]);
    expect(res.changed).toEqual([]);
    expect(res.unchanged).toEqual(["my-plugin"]);
  });
});

describe("removePluginsFromConfig", () => {
  it("removes bare-string entries", () => {
    write("plugins:\n  - keep-me\n  - drop-me\n");
    const res = removePluginsFromConfig(configPath, ["drop-me"]);
    expect(res.changed).toEqual(["drop-me"]);
    expect(pluginsList()).toEqual(["keep-me"]);
  });

  it("removes module-object entries including their config", () => {
    write('plugins:\n  - keep-me\n  - module: "drop-me"\n    config:\n      key: value\n');
    const res = removePluginsFromConfig(configPath, ["drop-me"]);
    expect(res.changed).toEqual(["drop-me"]);
    expect(pluginsList()).toEqual(["keep-me"]);
  });

  it("reports names that were not listed", () => {
    write("plugins:\n  - keep-me\n");
    const res = removePluginsFromConfig(configPath, ["not-there"]);
    expect(res.changed).toEqual([]);
    expect(res.unchanged).toEqual(["not-there"]);
    expect(pluginsList()).toEqual(["keep-me"]);
  });

  it("no-ops when plugins key or file is missing", () => {
    write("agent:\n  defaultProvider: openai\n");
    expect(removePluginsFromConfig(configPath, ["x"]).changed).toEqual([]);
    expect(removePluginsFromConfig(join(dir, "missing.yaml"), ["x"]).changed).toEqual([]);
  });
});
