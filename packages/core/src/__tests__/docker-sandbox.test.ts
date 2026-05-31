import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DockerRunner, type DockerRunResult, DockerSandbox } from "../sandboxes/docker.js";

interface CapturedCall {
  args: string[];
}

/** Builds a runner that records calls and returns canned responses keyed by the docker subcommand. */
function fakeRunner(behaviors: {
  run?: (call: CapturedCall) => DockerRunResult;
  exec?: (call: CapturedCall) => DockerRunResult;
  rm?: (call: CapturedCall) => DockerRunResult;
}): { runner: DockerRunner; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const runner: DockerRunner = async (args) => {
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
  dir = mkdtempSync(join(tmpdir(), "docker-sandbox-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("DockerSandbox.prepare", () => {
  it("invokes docker run with cwd bind mount, sandboxWorkdir, and image", async () => {
    const { runner, calls } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "container-abc\n", stderr: "" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine:latest", runner });

    const handle = await sandbox.prepare({ cwd: dir });
    expect(handle.kind).toBe("docker");
    expect(handle.cwd).toBe("/work");

    const runCall = calls.find((c) => c.args[0] === "run");
    expect(runCall).toBeDefined();
    expect(runCall?.args).toContain("-v");
    expect(runCall?.args).toContain(`${dir}:/work`);
    expect(runCall?.args).toContain("-w");
    expect(runCall?.args).toContain("/work");
    expect(runCall?.args).toContain("alpine:latest");
    expect(runCall?.args).toContain("infinity"); // sleep entrypoint
  });

  it("passes provider env, prepare env, and extra mounts through to docker run", async () => {
    const { runner, calls } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "container-xyz\n", stderr: "" }),
    });
    const sandbox = new DockerSandbox({
      imageName: "node:22",
      mounts: [{ hostPath: "/cache", sandboxPath: "/cache", readonly: true }],
      env: { FOO: "1" },
      runner,
    });

    await sandbox.prepare({ cwd: dir, env: { BAR: "2" } });
    const args = calls[0].args;

    expect(args.join(" ")).toContain("-v /cache:/cache:ro");
    expect(args.join(" ")).toContain("-e FOO=1");
    expect(args.join(" ")).toContain("-e BAR=2");
  });

  it("throws when docker run fails with a useful error", async () => {
    const { runner } = fakeRunner({
      run: () => ({ exitCode: 125, stdout: "", stderr: "Error response from daemon" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });

    await expect(sandbox.prepare({ cwd: dir })).rejects.toThrow(/docker run failed/);
  });

  it("throws when docker run produces no container id", async () => {
    const { runner } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });

    await expect(sandbox.prepare({ cwd: dir })).rejects.toThrow(/no container id/);
  });
});

describe("DockerSandbox.exec", () => {
  it("runs `docker exec -w <cwd> <id> bash -c <cmd>` against the container", async () => {
    const { runner, calls } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "container-abc\n", stderr: "" }),
      exec: () => ({ exitCode: 0, stdout: "hello\n", stderr: "" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });
    const handle = await sandbox.prepare({ cwd: dir });

    const r = await sandbox.exec(handle, "echo hello");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hello");

    const execCall = calls.find((c) => c.args[0] === "exec");
    expect(execCall?.args).toEqual(["exec", "-w", "/work", "container-abc", "bash", "-c", "echo hello"]);
  });

  it("threads per-call env vars and cwd into docker exec", async () => {
    const { runner, calls } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "cid\n", stderr: "" }),
      exec: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });
    const handle = await sandbox.prepare({ cwd: dir });

    await sandbox.exec(handle, "echo $FOO", { cwd: "/elsewhere", env: { FOO: "bar" } });

    const execArgs = calls.find((c) => c.args[0] === "exec")?.args ?? [];
    expect(execArgs.slice(0, 5)).toEqual(["exec", "-w", "/elsewhere", "-e", "FOO=bar"]);
    expect(execArgs).toContain("cid");
  });

  it("translates host bind-mount cwd to the container's /work path", async () => {
    // Regression: the exec tool passes `opts.cwd = context.workingDirectory`
    // which is the HOST worktree path. The container only has the bind
    // mount at /work, so we need to translate before docker exec, or every
    // command fails with "no such directory".
    const { runner, calls } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "cid\n", stderr: "" }),
      exec: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });
    const handle = await sandbox.prepare({ cwd: dir });

    // Caller passes the host path (what tool/loop sees) — sandbox must
    // remap it to the container path.
    await sandbox.exec(handle, "git status", { cwd: dir });

    const execArgs = calls.find((c) => c.args[0] === "exec")?.args ?? [];
    expect(execArgs[1]).toBe("-w");
    expect(execArgs[2]).toBe("/work");
  });

  it("translates a subpath of the host bind-mount to the container's matching subpath", async () => {
    const { runner, calls } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "cid\n", stderr: "" }),
      exec: () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });
    const handle = await sandbox.prepare({ cwd: dir });

    await sandbox.exec(handle, "ls", { cwd: `${dir}/packages/core` });

    const execArgs = calls.find((c) => c.args[0] === "exec")?.args ?? [];
    expect(execArgs[2]).toBe("/work/packages/core");
  });
});

describe("DockerSandbox file IO", () => {
  it("readFile/writeFile go through the host bind-mount path", async () => {
    const { runner } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "cid\n", stderr: "" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });
    const handle = await sandbox.prepare({ cwd: dir });

    await sandbox.writeFile(handle, "note.md", "from agent");
    expect(await sandbox.readFile(handle, "note.md")).toBe("from agent");
  });

  it("readFile honors absolute paths", async () => {
    const { runner } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "cid\n", stderr: "" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });
    const handle = await sandbox.prepare({ cwd: "/elsewhere" });

    writeFileSync(join(dir, "abs.txt"), "abs-content");
    expect(await sandbox.readFile(handle, join(dir, "abs.txt"))).toBe("abs-content");
  });
});

describe("DockerSandbox.cleanup", () => {
  it("invokes docker rm -f on the container id", async () => {
    const { runner, calls } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "container-abc\n", stderr: "" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });
    const handle = await sandbox.prepare({ cwd: dir });

    await sandbox.cleanup(handle);
    const rmCall = calls.find((c) => c.args[0] === "rm");
    expect(rmCall?.args).toEqual(["rm", "-f", "container-abc"]);
  });

  it("swallows cleanup errors (best-effort)", async () => {
    const { runner } = fakeRunner({
      run: () => ({ exitCode: 0, stdout: "cid\n", stderr: "" }),
      rm: () => ({ exitCode: 1, stdout: "", stderr: "no such container" }),
    });
    const sandbox = new DockerSandbox({ imageName: "alpine", runner });
    const handle = await sandbox.prepare({ cwd: dir });

    // Should not throw.
    await expect(sandbox.cleanup(handle)).resolves.toBeUndefined();
  });
});
