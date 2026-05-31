import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateBundleMember,
  BundleRegistry,
  discoverBundleMembers,
  parseBundleData,
  uninstallBundleCascade,
} from "../resources/bundle.js";
import { ResourceLoader } from "../resources/loader.js";
import { ResourceRegistry } from "../resources/registry.js";

const SKILL_MD = `---
name: pdf-processor
description: Extract text from PDFs.
allowed-tools: [read]
---

Body.
`;

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tai-bundle-"));

  // manifest
  writeFileSync(
    join(root, "manifest.yaml"),
    `kind: bundle
id: quintonm/test-bundle
version: 1.0.0
description: Test bundle for unit tests
data:
  author: quintonm
`,
    "utf8",
  );

  // skill
  mkdirSync(join(root, "skills", "pdf-processor"), { recursive: true });
  writeFileSync(join(root, "skills", "pdf-processor", "SKILL.md"), SKILL_MD, "utf8");

  // tool (file-manifest)
  mkdirSync(join(root, "tools", "fetch-url"), { recursive: true });
  writeFileSync(
    join(root, "tools", "fetch-url", "manifest.yaml"),
    `kind: tool
id: quintonm/fetch-url
version: 0.1.0
description: HTTP fetch tool
`,
    "utf8",
  );

  // workflow (bare yaml)
  mkdirSync(join(root, "workflows"), { recursive: true });
  writeFileSync(
    join(root, "workflows", "nightly-report.yaml"),
    `name: nightly-report
steps:
  - name: noop
    type: shell
    command: "true"
`,
    "utf8",
  );

  // kb (bare dir)
  mkdirSync(join(root, "kb", "best-practices"), { recursive: true });
  writeFileSync(join(root, "kb", "best-practices", "README.md"), "# Best practices guide\n", "utf8");

  // agent
  mkdirSync(join(root, "agents", "review-bot"), { recursive: true });
  writeFileSync(
    join(root, "agents", "review-bot", "manifest.yaml"),
    `kind: agent
id: quintonm/review-bot
version: 0.0.1
description: PR reviewer
data:
  instructions: Be terse
  tools: [read]
`,
    "utf8",
  );

  return root;
}

describe("discoverBundleMembers — convention layout", () => {
  let root: string;
  beforeEach(() => {
    root = makeFixture();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("auto-discovers members across every supported kind", () => {
    const members = discoverBundleMembers(root, {});
    const byKind = new Map<string, string[]>();
    for (const m of members) {
      const existing = byKind.get(m.kind) ?? [];
      existing.push(m.id);
      byKind.set(m.kind, existing);
    }
    expect(byKind.get("skill")).toEqual(["pdf-processor"]);
    expect(byKind.get("tool")).toEqual(["quintonm/fetch-url"]);
    expect(byKind.get("workflow")).toEqual(["nightly-report"]);
    expect(byKind.get("kb")).toEqual(["kb/best-practices"]);
    expect(byKind.get("agent")).toEqual(["quintonm/review-bot"]);
  });

  it("honors `false` to opt-out of a kind", () => {
    const members = discoverBundleMembers(root, { members: { workflow: false } as never });
    expect(members.find((m) => m.kind === "workflow")).toBeUndefined();
    // Other kinds still discovered.
    expect(members.find((m) => m.kind === "skill")).toBeDefined();
  });

  it("honors `path` to rename the dir", () => {
    // Move skills/ to rituals/
    mkdirSync(join(root, "rituals", "pdf-processor"), { recursive: true });
    writeFileSync(join(root, "rituals", "pdf-processor", "SKILL.md"), SKILL_MD, "utf8");
    rmSync(join(root, "skills"), { recursive: true, force: true });

    const members = discoverBundleMembers(root, {
      members: { skill: { path: "rituals" } } as never,
    });
    expect(members.find((m) => m.kind === "skill")?.id).toBe("pdf-processor");
  });

  it("honors include/exclude globs", () => {
    // Add a legacy skill that should be excluded.
    mkdirSync(join(root, "skills", "legacy-old"), { recursive: true });
    writeFileSync(
      join(root, "skills", "legacy-old", "SKILL.md"),
      `---\nname: legacy-old\ndescription: old\n---\nbody`,
      "utf8",
    );

    const members = discoverBundleMembers(root, {
      members: { skill: { exclude: ["skills/legacy-*"] } } as never,
    });
    const skills = members.filter((m) => m.kind === "skill").map((m) => m.id);
    expect(skills).toEqual(["pdf-processor"]);
  });
});

describe("BundleRegistry", () => {
  it("registers and retrieves a bundle body", () => {
    const reg = new BundleRegistry();
    reg.register({
      manifest: { kind: "bundle", id: "x/y", version: "1.0.0" },
      origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
      body: { manifest: { kind: "bundle", id: "x/y", version: "1.0.0" }, rootPath: "/x", members: [] },
    });
    expect(reg.get("x/y")?.rootPath).toBe("/x");
    expect(reg.list().map((r) => r.manifest.id)).toEqual(["x/y"]);
  });

  it("rejects mis-kinded resources", () => {
    const reg = new BundleRegistry();
    expect(() =>
      reg.register({
        manifest: { kind: "tool", id: "x", version: "1.0.0" },
        origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
        body: { manifest: { kind: "bundle", id: "x", version: "1.0.0" }, rootPath: "/x", members: [] },
      } as never),
    ).toThrow(/expected manifest\.kind="bundle"/);
  });
});

describe("ResourceLoader default bundle resolver", () => {
  let root: string;
  beforeEach(() => {
    root = makeFixture();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads a bundle from a file path with auto-discovered members in the body", async () => {
    const loader = new ResourceLoader();
    const resource = await loader.load(`file://${root}`);
    expect(resource.manifest.kind).toBe("bundle");
    expect(resource.manifest.id).toBe("quintonm/test-bundle");
    const body = resource.body as { members: Array<{ kind: string; id: string }>; author?: string };
    expect(body.author).toBe("quintonm");
    const ids = body.members.map((m) => `${m.kind}:${m.id}`).sort();
    expect(ids).toEqual([
      "agent:quintonm/review-bot",
      "kb:kb/best-practices",
      "skill:pdf-processor",
      "tool:quintonm/fetch-url",
      "workflow:nightly-report",
    ]);
  });
});

describe("activateBundleMember / uninstallBundleCascade", () => {
  let root: string;
  beforeEach(() => {
    root = makeFixture();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("activates a tool member through the loader and stamps origin.bundleId", async () => {
    const loader = new ResourceLoader();
    const bundle = await loader.load(`file://${root}`);
    const member = (bundle.body as { members: Array<{ kind: string; id: string; sourcePath: string }> }).members.find(
      (m) => m.kind === "tool",
    )!;
    const toolReg = new ResourceRegistry();
    const result = await activateBundleMember({
      bundleId: bundle.manifest.id,
      member: member as never,
      loader,
      targetRegistries: { tool: toolReg },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resource.origin.bundleId).toBe("quintonm/test-bundle");
    }
    expect(toolReg.get({ kind: "tool", id: "quintonm/fetch-url" })).toBeDefined();
  });

  it("cascading uninstall removes only members stamped with the given bundleId", async () => {
    const toolReg = new ResourceRegistry();
    const stamp = "quintonm/test-bundle";

    toolReg.register({
      manifest: { kind: "tool", id: "from-bundle", version: "1.0.0" },
      origin: { scheme: "file", uri: "file:///x", loadedAt: 0, bundleId: stamp },
      body: null,
    });
    toolReg.register({
      manifest: { kind: "tool", id: "stand-alone", version: "1.0.0" },
      origin: { scheme: "file", uri: "file:///y", loadedAt: 0 },
      body: null,
    });

    const removed = uninstallBundleCascade(stamp, { tool: toolReg });
    expect(removed).toEqual([{ kind: "tool", id: "from-bundle" }]);
    expect(toolReg.get({ kind: "tool", id: "stand-alone" })).toBeDefined();
    expect(toolReg.get({ kind: "tool", id: "from-bundle" })).toBeUndefined();
  });
});

describe("parseBundleData", () => {
  it("returns an empty options object when data is omitted", () => {
    const opts = parseBundleData({ kind: "bundle", id: "x/y", version: "1.0.0" });
    expect(opts.members).toBeUndefined();
  });

  it("rejects non-object members", () => {
    expect(() =>
      parseBundleData({ kind: "bundle", id: "x", version: "1.0.0", data: { members: [1, 2] } as never }),
    ).toThrow(/members/);
  });
});
