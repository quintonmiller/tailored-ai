/**
 * `tai start` / `stop` / `restart` / `status` — run TAI as a background service.
 *
 * Until this existed, `tai` only ran in the foreground, so every deployment that
 * wanted TAI to survive a closed terminal wrote its own supervisor. This repo
 * carried one for a while; it encoded one machine's instance names and pid-file
 * layout, and was removed as deployment logic that had no seam to sit on.
 *
 * ## What this does not do
 *
 * It does **not** run the lifecycle hooks. Those fire inside the serve process
 * itself (`tai:init:start` … `tai:shutdown:end`), which is what lets
 * `tai:init:end` and `tai:shutdown:start` reach a live runtime and call a tool.
 * A supervisor that ran them in its own short-lived process would have to hand
 * back that capability for nothing. So this stays thin: spawn, wait, signal,
 * report.
 *
 * The consequence worth knowing: a `tai:init:start` hook that refuses causes the
 * *child* to exit non-zero, and `start` learns about it by watching the child
 * rather than by running the hook itself.
 *
 * ## Scoped by TAI_HOME, not by an instance registry
 *
 * The pid and log files live under the home directory, so two deployments are
 * two homes and need no list of instances anywhere. `-c <config>` and `TAI_HOME`
 * already select one, and that same selection is the isolation.
 *
 * ## Pid liveness is the only truth
 *
 * There is no stored "owner" marker. A crashed process releases its slot with
 * nothing stale to clean up, and a pid file whose process is gone is treated as
 * absent rather than as a lock.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig } from "@tailored-ai/core";
import { resolveHomePaths } from "../home.js";

export const SERVICE_USAGE = `tai service commands:

  tai start   [-c <config>]   Start TAI in the background
  tai stop    [-c <config>]   Stop it, waiting for a clean exit
  tai restart [-c <config>]   Stop then start
  tai status  [-c <config>]   Is it running, and is it answering?

Files live under the home directory, so TAI_HOME (or -c) selects the instance:
  <home>/run/agent.pid
  <home>/logs/agent.log`;

/** How long to wait for readiness before giving up on a start. */
const READY_TIMEOUT_MS = 120_000;
/** How long to wait for a clean exit before escalating to SIGKILL. */
const STOP_TIMEOUT_MS = 30_000;

function pidFile(homeDir: string): string {
  return resolve(homeDir, "run", "agent.pid");
}

function logFile(homeDir: string): string {
  return resolve(homeDir, "logs", "agent.log");
}

/**
 * Marker meaning "this stop is half of a restart".
 *
 * Written by {@link cmdRestart} before it stops, read by the serve process on
 * its way down, cleared once the replacement is up. It exists because the
 * shutdown hooks run *inside* the process being stopped, so the supervisor
 * cannot tell them anything directly — by the time it knows a restart is
 * happening, the thing that would listen is already going away.
 *
 * The distinction matters as soon as a `tai:shutdown:end` hook releases
 * something expensive. Cycling a shared model server to restart an agent
 * reloads tens of gigabytes for nothing, and `restart` is the most common
 * operation during a config change. Core does not know what the hook releases;
 * it reports why the process is stopping, and the hook decides.
 */
function restartMarker(homeDir: string): string {
  return resolve(homeDir, "run", "restarting");
}

/** Why the process is going down. Read by the serve process for its hooks. */
export function shutdownReason(homeDir: string): "restart" | "stop" {
  return existsSync(restartMarker(homeDir)) ? "restart" : "stop";
}

/** The live pid for this home, or undefined when nothing is running. */
export function readLivePid(homeDir: string): number | undefined {
  const file = pidFile(homeDir);
  if (!existsSync(file)) return undefined;
  const raw = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(raw, 0);
    return raw;
  } catch {
    // The process is gone. A stale file is not a lock — clear it so the next
    // start is not blocked by a crash that already finished.
    try {
      rmSync(file);
    } catch {
      /* best effort */
    }
    return undefined;
  }
}

function healthUrl(homeDir: string): string {
  const config = loadConfig(resolveHomePaths(homeDir).configPath);
  const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  return `http://${host}:${config.server.port}/api/health`;
}

async function isAnswering(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function cmdStart(homeDir: string, argv: string[]): Promise<number> {
  const existing = readLivePid(homeDir);
  if (existing !== undefined) {
    console.log(`Already running (pid ${existing}).`);
    return 0;
  }

  mkdirSync(dirname(pidFile(homeDir)), { recursive: true });
  mkdirSync(dirname(logFile(homeDir)), { recursive: true });

  // Detached, with stdio to a file. `detached` puts the child in its own
  // session so it survives this process exiting, and an inherited pipe would
  // keep it tethered to a parent that is about to go away.
  const out = openLog(logFile(homeDir));
  const child = spawn(process.execPath, [process.argv[1], ...argv], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, TAI_HOME: homeDir },
  });
  child.unref();

  if (child.pid === undefined) {
    console.error("Failed to spawn.");
    return 1;
  }
  writeFileSync(pidFile(homeDir), String(child.pid));

  // Wait for *ready*, not for *spawned*. A live pid means the process exists,
  // not that channels are connected or that a `tai:init:start` hook let it
  // through — a hook that refuses makes the child exit, and that has to read as
  // a failed start rather than a start that is still warming up.
  const url = healthUrl(homeDir);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  process.stdout.write("Starting");
  while (Date.now() < deadline) {
    if (await isAnswering(url)) {
      process.stdout.write("\n");
      console.log(`Started (pid ${child.pid}).`);
      return 0;
    }
    if (readLivePid(homeDir) === undefined) {
      process.stdout.write("\n");
      console.error(`Exited during startup. Last lines of ${logFile(homeDir)}:\n`);
      console.error(tailLog(logFile(homeDir), 20));
      return 1;
    }
    process.stdout.write(".");
    await sleep(1000);
  }
  process.stdout.write("\n");
  console.error(
    `Did not answer ${url} within ${READY_TIMEOUT_MS / 1000}s. It may still be loading; see ${logFile(homeDir)}`,
  );
  return 1;
}

export async function cmdStop(homeDir: string): Promise<number> {
  const pid = readLivePid(homeDir);
  if (pid === undefined) {
    console.log("Not running.");
    return 0;
  }

  // Signal the process *group*: the serve process spawns children of its own,
  // and signalling only the leader leaves them behind.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  process.stdout.write("Stopping");
  while (Date.now() < deadline) {
    if (readLivePid(homeDir) === undefined) {
      process.stdout.write("\n");
      console.log("Stopped.");
      return 0;
    }
    process.stdout.write(".");
    await sleep(500);
  }

  // The shutdown path runs `tai:shutdown:start` and `tai:shutdown:end` hooks,
  // so a slow stop may be a hook doing real work. Escalating is still right
  // eventually — an instance that cannot be stopped is worse — but say what
  // happened rather than reporting a clean stop.
  process.stdout.write("\n");
  console.error(
    `Did not exit within ${STOP_TIMEOUT_MS / 1000}s; sending SIGKILL. Shutdown hooks may not have finished.`,
  );
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(pidFile(homeDir));
  } catch {
    /* best effort */
  }
  return 1;
}

export async function cmdStatus(homeDir: string): Promise<number> {
  const pid = readLivePid(homeDir);
  if (pid === undefined) {
    console.log(`stopped    ${homeDir}`);
    return 1;
  }
  // A live pid and a live agent are different claims, and the gap between them
  // is where "it says it is running" stops being useful.
  const answering = await isAnswering(healthUrl(homeDir));
  console.log(`${answering ? "running" : "starting"}    ${homeDir}  (pid ${pid})`);
  if (!answering) console.log(`  not answering ${healthUrl(homeDir)} yet — see ${logFile(homeDir)}`);
  return 0;
}

export async function cmdRestart(homeDir: string, argv: string[]): Promise<number> {
  mkdirSync(dirname(restartMarker(homeDir)), { recursive: true });
  writeFileSync(restartMarker(homeDir), String(Date.now()));
  try {
    const stopped = await cmdStop(homeDir);
    if (stopped !== 0) return stopped;
    await sleep(500);
    return await cmdStart(homeDir, argv);
  } finally {
    // Cleared whatever happened. A marker left by a failed restart would make
    // the *next* ordinary stop look like a restart, and a hook would then
    // decline to release something nothing is coming back for.
    try {
      rmSync(restartMarker(homeDir));
    } catch {
      /* best effort */
    }
  }
}

function openLog(path: string): number {
  // Appended, not truncated: the log of the run that just failed is usually the
  // thing you want after a start that did not come up.
  return openSync(path, "a");
}

function tailLog(path: string, lines: number): string {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}
