/**
 * `rooms.rooms[].archived` is a TRI-state, and the third state is the one that
 * matters: leaving the key out must change nothing.
 *
 * `reconcileRooms()` runs on every config reload. If absence meant "not
 * archived", every room retired at runtime — by `/room archive`, or by an agent
 * calling the tool — would spring back to life the next time anything touched
 * config, silently. This deployment has already been bitten once by the
 * mirror-image of that bug: `check_in_minutes` COALESCEd on write, so deleting
 * the key from config kept the stored value and the file and the database
 * disagreed with no way to tell from the file.
 *
 * So all three cases get a test, and the absent case gets two.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let home: string;

const REF = "local:trip";

beforeEach(() => {
  db = initDatabase(":memory:");
  home = mkdtempSync(join(tmpdir(), "tai-rooms-archive-cfg-"));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

/** A runtime whose config declares one room, optionally with `archived`. */
function makeRuntime(archived?: boolean): AgentRuntime {
  const config = {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
    agent: {
      defaultProvider: "openai_compatible",
      maxToolRounds: 1,
      maxHistoryTokens: 2000,
      temperature: 0.3,
      extraInstructions: "",
    },
    agents: { coordinator: {} },
    channels: {},
    tools: {},
    custom_tools: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./c", kbDirectory: "./k" },
    prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
    permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
    workflows: { directory: "./w" },
    tasks: { backend: "native" as const },
    rooms: {
      rooms: [{ name: "trip", ref: REF, ...(archived === undefined ? {} : { archived }) }],
      subscriptions: [{ agent: "coordinator", room: "trip", wakeOn: "all" as const }],
    },
  } as unknown as AgentConfig;

  return new AgentRuntime(
    {
      configPath: "/dev/null",
      db,
      contextDir: join(home, "c"),
      kbDir: join(home, "k"),
      createTools: () => [],
      createProvider: () => ({ provider: { name: "f", chat: async () => ({}) } as never, model: "x" }),
    },
    () => config,
    config,
  );
}

describe("rooms.rooms[].archived", () => {
  it("archives when config says true", () => {
    const runtime = makeRuntime(true);
    runtime.reconcileRooms();

    expect(runtime.getRoomStore().getRoomByRef(REF)?.archivedAt).toBeTruthy();
    // The declared subscription is still written — inert, and there to be
    // restored the moment the room comes back.
    expect(runtime.getRoomStore().listSubscriptions()).toHaveLength(1);
    expect(runtime.getRoomStore().listActiveSubscriptions()).toEqual([]);
  });

  it("restores when config says false", () => {
    const archiving = makeRuntime(true);
    archiving.reconcileRooms();

    const restoring = makeRuntime(false);
    restoring.reconcileRooms();

    expect(restoring.getRoomStore().getRoomByRef(REF)?.archivedAt).toBeUndefined();
    expect(restoring.getRoomStore().listActiveSubscriptions()).toHaveLength(1);
  });

  it("leaves a runtime archive alone when config says nothing", () => {
    // The regression this file exists for. An agent archives the room; a config
    // reload must not undo that.
    const runtime = makeRuntime(undefined);
    runtime.reconcileRooms();
    runtime.getRoomStore().archiveRoom(REF, { by: "coordinator", reason: "trip is over" });

    runtime.reconcileRooms();

    expect(runtime.getRoomStore().getRoomByRef(REF)?.archivedAt).toBeTruthy();
    expect(runtime.getRoomStore().getRoomByRef(REF)?.archiveReason).toBe("trip is over");
  });

  it("leaves a live room live when config says nothing", () => {
    // The other half: absence must not archive anything either.
    const runtime = makeRuntime(undefined);
    runtime.reconcileRooms();
    runtime.reconcileRooms();

    expect(runtime.getRoomStore().getRoomByRef(REF)?.archivedAt).toBeUndefined();
  });

  it("does not re-stamp on every reload", () => {
    const runtime = makeRuntime(true);
    runtime.reconcileRooms();
    const first = runtime.getRoomStore().getRoomByRef(REF)?.archivedAt;

    runtime.reconcileRooms();
    runtime.reconcileRooms();

    // Same timestamp: `archiveRoom` is a no-op on an already-archived room, so
    // "when did we retire this?" stays answerable and the announcer stays quiet.
    expect(runtime.getRoomStore().getRoomByRef(REF)?.archivedAt).toBe(first);
  });
});
