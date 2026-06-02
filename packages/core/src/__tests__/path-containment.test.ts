/**
 * Path-containment unit tests covering the sibling-prefix and symlink-escape
 * vectors called out in #59. The pre-fix `startsWith` check incorrectly
 * allowed `/srv/project-secrets` when `/srv/project` was on the allowlist;
 * symlink-resolution wasn't done at all.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPathContained, isPathContainedRealpath } from "../tools/path-containment.js";

describe("isPathContained — lexical", () => {
  it("returns true for the parent itself", () => {
    expect(isPathContained("/srv/project", "/srv/project")).toBe(true);
  });

  it("returns true for a true descendant", () => {
    expect(isPathContained("/srv/project/src/index.ts", "/srv/project")).toBe(true);
  });

  it("rejects sibling-prefix paths (the #59 bug)", () => {
    expect(isPathContained("/srv/project-secrets/db.sqlite", "/srv/project")).toBe(false);
    expect(isPathContained("/srv/projectx", "/srv/project")).toBe(false);
  });

  it("flattens .. against the parent", () => {
    expect(isPathContained("/srv/project/../../etc/passwd", "/srv/project")).toBe(false);
  });

  it("flattens redundant separators", () => {
    expect(isPathContained("/srv/project///src", "/srv/project")).toBe(true);
  });

  it("normalizes relative paths via cwd", () => {
    expect(isPathContained("project/src/x.ts", "/srv/project", "/srv")).toBe(true);
    expect(isPathContained("project-secrets/x", "/srv/project", "/srv")).toBe(false);
  });
});

describe("isPathContainedRealpath — symlink escape", () => {
  let root: string;
  let allowed: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tai-pc-"));
    allowed = join(root, "allowed");
    outside = join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    writeFileSync(join(allowed, "safe.txt"), "ok");
    writeFileSync(join(outside, "secret.txt"), "secret");
    // Place a symlink inside `allowed` that points at the outside dir.
    symlinkSync(outside, join(allowed, "escape"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("allows true descendants", () => {
    expect(isPathContainedRealpath(join(allowed, "safe.txt"), allowed)).toBe(true);
  });

  it("rejects sibling-prefix paths even after realpath resolution", () => {
    const siblingPrefix = `${allowed}-secrets`;
    mkdirSync(siblingPrefix);
    try {
      writeFileSync(join(siblingPrefix, "x"), "y");
      expect(isPathContainedRealpath(join(siblingPrefix, "x"), allowed)).toBe(false);
    } finally {
      rmSync(siblingPrefix, { recursive: true, force: true });
    }
  });

  it("rejects symlink escape from within the allowed dir", () => {
    // /tmp/.../allowed/escape -> /tmp/.../outside
    // /tmp/.../allowed/escape/secret.txt resolves to /tmp/.../outside/secret.txt.
    expect(isPathContainedRealpath(join(allowed, "escape", "secret.txt"), allowed)).toBe(false);
  });

  it("allows writes to a not-yet-existing descendant by resolving the nearest parent", () => {
    expect(isPathContainedRealpath(join(allowed, "new", "file.txt"), allowed)).toBe(true);
  });

  it("rejects writes targeting a symlinked-out path even when the leaf doesn't exist yet", () => {
    expect(isPathContainedRealpath(join(allowed, "escape", "new-file.txt"), allowed)).toBe(false);
  });
});
