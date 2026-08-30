/**
 * `tai restart` must not look like `tai stop` to a shutdown hook.
 *
 * The shutdown hooks run inside the process being stopped, so the supervisor
 * cannot tell them anything directly — by the time it knows a restart is
 * happening, the thing that would listen is already going away. A marker file
 * is how the fact crosses that gap.
 *
 * This is not a nicety. Measured on a real deployment before the marker existed:
 * `tai restart` released the shared model server on the way down and reloaded it
 * on the way up, cycling a 27B model to change a config line. Restart is the
 * most common operation there is, so the cost lands constantly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shutdownReason } from "../commands/service.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(resolve(tmpdir(), "tai-service-"));
  mkdirSync(resolve(home, "run"), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("shutdownReason", () => {
  it("is a plain stop when nothing says otherwise", () => {
    expect(shutdownReason(home)).toBe("stop");
  });

  it("is a restart while the marker is present", () => {
    writeFileSync(resolve(home, "run", "restarting"), "1");
    expect(shutdownReason(home)).toBe("restart");
  });

  it("is a stop again once the marker is cleared", () => {
    // `cmdRestart` clears it in a `finally`, so a restart that failed halfway
    // does not leave the *next* ordinary stop looking like a restart — which
    // would have a hook decline to release something nothing is coming back for.
    const marker = resolve(home, "run", "restarting");
    writeFileSync(marker, "1");
    rmSync(marker);
    expect(shutdownReason(home)).toBe("stop");
  });

  it("does not confuse one home for another", () => {
    // Two deployments are two homes, and a restart of one must not make the
    // other's stop look like a restart.
    const other = mkdtempSync(resolve(tmpdir(), "tai-service-other-"));
    try {
      mkdirSync(resolve(other, "run"), { recursive: true });
      writeFileSync(resolve(home, "run", "restarting"), "1");
      expect(shutdownReason(home)).toBe("restart");
      expect(shutdownReason(other)).toBe("stop");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
