/**
 * Two TAI instances on one machine deliberately share port 3000: only one runs
 * at a time, and the bind is a kernel-level lock that no bookkeeping of ours
 * can get wrong. Distinct ports would make an accidental double-start
 * *succeed*, which is the outcome worth preventing.
 *
 * That only works if the collision is legible. It was not: `serve()` registered
 * no `error` listener, so `EADDRINUSE` surfaced as an unhandled event and the
 * second instance died on a raw stack trace that never named the port.
 */

import type { Server } from "node:net";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkPortAvailable, portInUseMessage } from "../port.js";

let held: Server | undefined;

afterEach(async () => {
  if (held) await new Promise<void>((r) => held?.close(() => r()));
  held = undefined;
});

function listen(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, hostname, () => {
      held = s;
      const addr = s.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });
}

describe("checkPortAvailable", () => {
  it("says yes for a free port", async () => {
    const port = await listen("127.0.0.1");
    await new Promise<void>((r) => held?.close(() => r()));
    held = undefined;

    expect(await checkPortAvailable("127.0.0.1", port)).toEqual({ ok: true });
  });

  it("reports EADDRINUSE when another process holds it", async () => {
    const port = await listen("127.0.0.1");

    expect(await checkPortAvailable("127.0.0.1", port)).toEqual({ ok: false, code: "EADDRINUSE" });
  });

  /**
   * The check runs before the Discord login, cron and autopilot, so it must
   * release what it borrowed — otherwise the real bind moments later collides
   * with the probe and the instance refuses to start itself.
   */
  it("releases the port it probed", async () => {
    const port = await listen("127.0.0.1");
    await new Promise<void>((r) => held?.close(() => r()));
    held = undefined;

    expect(await checkPortAvailable("127.0.0.1", port)).toEqual({ ok: true });
    expect(await checkPortAvailable("127.0.0.1", port)).toEqual({ ok: true });
  });
});

describe("portInUseMessage", () => {
  it("names the port and how to find who holds it", () => {
    const msg = portInUseMessage("0.0.0.0", 3000);

    expect(msg).toContain("3000");
    expect(msg).toContain("tai-ctl.sh status");
  });

  /** The likely cause is another instance, not a mystery — say so. */
  it("points at the instance most likely responsible", () => {
    expect(portInUseMessage("0.0.0.0", 3000)).toMatch(/another TAI instance/i);
  });
});
