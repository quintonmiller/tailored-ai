/**
 * The contract the CLI's deploy discovery enforces. These assertions mirror
 * `validateTarget` in packages/cli/src/deploy/registry.ts: if this package
 * drifts from that shape, `tai deploy list` reports it as skipped and the
 * target silently is not there. Catching it here beats catching it after
 * publish.
 */

import { describe, expect, it } from "vitest";
import { deployTargets, meta } from "../index.js";

describe("deployTargets export", () => {
  it("is an array", () => {
    expect(Array.isArray(deployTargets)).toBe(true);
    expect(deployTargets.length).toBeGreaterThan(0);
  });

  it("satisfies every field the CLI validator requires", () => {
    for (const target of deployTargets) {
      expect(typeof target.id).toBe("string");
      expect(target.id.length).toBeGreaterThan(0);
      expect(typeof target.description).toBe("string");
      expect(typeof target.plan).toBe("function");
      expect(typeof target.up).toBe("function");
    }
  });

  it("registers under the documented id", () => {
    expect(deployTargets.map((t) => t.id)).toContain("aws-ec2");
  });

  it("provides extended help, since the target has flags nobody can guess", () => {
    const target = deployTargets.find((t) => t.id === "aws-ec2")!;
    expect(target.help).toMatch(/--model/);
    expect(target.help).toMatch(/--key-name/);
  });

  it("implements the optional down and status hooks", () => {
    const target = deployTargets.find((t) => t.id === "aws-ec2")!;
    expect(typeof target.down).toBe("function");
    expect(typeof target.status).toBe("function");
  });

  it("carries plugin meta for when it is also listed under plugins:", () => {
    expect(meta.name).toBe("@tailored-ai/deploy-aws");
  });

  it("has no default export, so the plugin loader never treats it as register(ctx)", async () => {
    const mod = await import("../index.js");
    expect((mod as { default?: unknown }).default).toBeUndefined();
  });
});
