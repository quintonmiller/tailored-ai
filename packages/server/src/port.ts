import { createServer } from "node:net";

/**
 * Port collisions are how a second TAI instance is stopped from running.
 *
 * Two deployments on one machine deliberately share port 3000: only one runs
 * at a time, agent prompts hardcode `localhost:3000` in many places, and the
 * bind is a kernel-level lock that no bookkeeping of ours can get wrong. Give
 * each instance its own port and an accidental double-start *succeeds*, which
 * is the outcome worth preventing.
 *
 * That only works if the collision is legible. See docs/multi-instance.md.
 */

export function portInUseMessage(hostname: string, port: number): string {
  return [
    `[server] port ${port} is already in use on ${hostname}.`,
    "",
    "Something is already listening there — most likely another TAI instance.",
    "  scripts/tai-ctl.sh status        # which instance holds the agent slot",
    "  scripts/tai-ctl.sh switch -i <instance>",
    "",
    "Two instances share one port on purpose: it is the lock that keeps only",
    "one running. Change server.port in config.yaml only if you actually want",
    "both up at once.",
  ].join("\n");
}

/**
 * Answer whether we can bind, before anything with side effects starts.
 *
 * The Discord gateway login, cron and autopilot all come up well before the
 * HTTP bind, so a doomed second start logs a second bot in and fires cron for
 * several seconds before the port collision kills it — with a duplicate bot
 * briefly live in the guild. Checking first turns that into a message and a
 * clean exit.
 *
 * This does not hold the port: it binds and releases, so a racing process
 * could still take it in between. That race is not the failure being
 * prevented (a person starting the wrong instance is), and the real bind
 * still reports it properly via the `error` listener in `start()`. A check
 * that reserved the port would have to hand the live socket to Hono, which
 * buys nothing here and couples the two.
 */
export function checkPortAvailable(
  hostname: string,
  port: number,
): Promise<{ ok: true } | { ok: false; code: string }> {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolvePromise({ ok: false, code: err.code ?? "UNKNOWN" });
    });
    probe.once("listening", () => {
      probe.close(() => resolvePromise({ ok: true }));
    });
    probe.listen(port, hostname);
  });
}
