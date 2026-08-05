/**
 * Parse the generated cloud-init script with `bash -n`.
 *
 * This script runs once, as root, on a remote box, with nobody watching. A
 * syntax error in it does not fail the deploy — `run-instances` succeeds, the
 * instance boots, and the only symptom is that TAI never comes up, with the
 * cause buried in /var/log/cloud-init-output.log. Every other test here checks
 * that the script *says* the right things; this one checks that bash can
 * actually read it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseOptions } from "../options.js";
import { renderUserData } from "../user-data.js";

const dir = mkdtempSync(join(tmpdir(), "tai-userdata-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function assertValidBash(name: string, args: string[]): void {
  const script = renderUserData(parseOptions(args));
  const path = join(dir, `${name}.sh`);
  writeFileSync(path, script);
  const res = spawnSync("bash", ["-n", path], { encoding: "utf-8" });
  expect(res.stderr, `bash rejected the generated script:\n${res.stderr}`).toBe("");
  expect(res.status).toBe(0);
}

const REGION = ["--region", "us-west-2"];

describe("generated user-data is valid bash", () => {
  it("with only the required options", () => {
    assertValidBash("plain", [...REGION, "--model", "llama3.2"]);
  });

  it("with every passthrough option set", () => {
    assertValidBash("full", [
      ...REGION,
      "--model",
      "m",
      "--base-url",
      "http://host:1/v1",
      "--api-key",
      "sk-secret",
      "--provider",
      "openai",
    ]);
  });

  it("when an option value contains a single quote", () => {
    // The values are interpolated into a shell script. A quote that escapes
    // its string turns arbitrary option text into arbitrary root commands on
    // first boot.
    assertValidBash("quote", [...REGION, "--model", "m", "--repo-ref", "it's-a-branch"]);
  });

  it("when an option value contains shell metacharacters", () => {
    assertValidBash("meta", [...REGION, "--model", "m", "--repo-ref", "a;b`c`$(d)&e|f"]);
  });
});

describe("generated user-data shell semantics", () => {
  const script = () => renderUserData(parseOptions([...REGION, "--model", "m"]));

  it("keeps the architecture command substitution intact", () => {
    // `\$(uname -m)` in a TS template must reach bash as `$(uname -m)`; if the
    // escape is ever mangled the compose download 404s on every deploy.
    expect(script()).toContain("$(uname -m)");
  });

  it("leaks no unevaluated TypeScript interpolation", () => {
    expect(script()).not.toContain("${");
  });
});
