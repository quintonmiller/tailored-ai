import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContainerRunner, ContainerRunResult } from "../sandboxes/container.js";
import { PodmanSandbox } from "../sandboxes/podman.js";

interface CapturedCall {
  args: string[];
}

function fakeRunner(behaviors: {
  run?: (call: CapturedCall) => ContainerRunResult;
  exec?: (call: CapturedCall) => ContainerRunResult;
  rm?: (call: CapturedCall) => ContainerRunResult;
}): { runner: ContainerRunner; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const runner: ContainerRunner = async (args) => {
    const call: CapturedCall = { args };
    calls.push(call);
    const sub = args[0];
    if (sub === "run" && behaviors.run) return behaviors.run(call);
    if (sub === "exec" && behaviors.exec) return behaviors.exec(call);
    if (sub === "rm" && behaviors.rm) return behaviors.rm(call);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runner, calls };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "podman-sandbox-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("PodmanSandbox", () => {
  it("exposes kind = 'podman' and tags handles accordingly", async () => {
    const { runner } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "container-pmn\n", stderr: "" }),
    });
    const sandbox = new PodmanSandbox({ imageName: "alpine", runner });
    expect(sandbox.kind).toBe("podman");

    const handle = await sandbox.prepare({ cwd: dir });
    expect(handle.kind).toBe("podman");
  });

  it("issues `run -d --rm -v <cwd>:/work -w /work --entrypoint sleep <image> infinity` like docker", async () => {
    const { runner, calls } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "container-pmn\n", stderr: "" }),
    });
    const sandbox = new PodmanSandbox({ imageName: "alpine", runner });
    await sandbox.prepare({ cwd: dir });

    const runCall = calls.find((c) => c.args[0] === "run");
    expect(runCall?.args).toContain("-v");
    expect(runCall?.args).toContain(`${dir}:/work`);
    expect(runCall?.args).toContain("--entrypoint");
    expect(runCall?.args).toContain("infinity");
  });

  it("propagates the podman binary in error messages on failure", async () => {
    const { runner } = fakeRunner({
      run: () => ({ exitCode: 125, stdout: "", stderr: "no such image" }),
    });
    const sandbox = new PodmanSandbox({ imageName: "alpine", runner });
    await expect(sandbox.prepare({ cwd: dir })).rejects.toThrow(/podman run failed/);
  });

  it("cleanup runs `rm -f <id>`", async () => {
    const { runner, calls } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "container-pmn\n", stderr: "" }),
    });
    const sandbox = new PodmanSandbox({ imageName: "alpine", runner });
    const handle = await sandbox.prepare({ cwd: dir });
    await sandbox.cleanup(handle);

    const rmCall = calls.find((c) => c.args[0] === "rm");
    expect(rmCall?.args).toEqual(["rm", "-f", "container-pmn"]);
  });
});
