/**
 * A clock the benchmark controls, so a scenario means the same thing on a
 * Tuesday afternoon as it does at 07:23 UTC on a Monday.
 *
 * Several scenarios resolve civil time — `books-a-one-off-wake`,
 * `books-a-recurring-wake`, `lists-booked-wakes`, `does-not-schedule-a-past-time`
 * — and until now they resolved it against whatever the wall clock said when
 * the run happened. Nothing was failing, which is exactly what made it worth
 * fixing: a published baseline was only reproducible on a similar day, and a
 * result that moved because of the calendar would have looked like a result
 * that moved because of the code. The same latent bug in a unit test cost a red
 * CI on `main` — "every monday at 8:30 within the next 2 hours" is a false
 * assertion for two hours a week (#492).
 *
 * **Pinned, not frozen.** A stopped clock breaks anything that measures elapsed
 * time: recorded latency, the schedule runner's poll tick, retry backoff. So
 * this returns `pinnedAt + (now - startedAt)` — the civil date, weekday and
 * timezone are fixed, and time still moves forward at one second per second.
 *
 * Registered under the id `pinned` and selected the way any other component is,
 * through `time.provider` in the generated config. Core ships only `system`, and
 * evals is a private package that builds its own runtime, so this needs no core
 * change — it is the seam from #480 used as intended.
 */

import { registerTimeProviderFactory, type TimeProvider } from "@tailored-ai/core";

/** Default pin: a Wednesday, mid-morning, well clear of any day boundary. */
export const DEFAULT_PINNED_AT = "2026-08-12T17:00:00.000Z";

/** Default zone. Pinned so DST and day-rollover behaviour do not depend on the host. */
export const DEFAULT_TIMEZONE = "America/Los_Angeles";

let registered = false;

/**
 * Make `time.provider: pinned` resolvable.
 *
 * Idempotent, because the registry throws on a duplicate id and each scenario
 * worker may build more than one runtime.
 */
export function registerPinnedClock(): void {
  if (registered) return;
  registered = true;

  registerTimeProviderFactory("pinned", (config): TimeProvider => {
    const options = (config.time?.options ?? {}) as { at?: unknown };
    const raw = typeof options.at === "string" ? options.at : DEFAULT_PINNED_AT;
    const pinnedAt = new Date(raw);
    if (Number.isNaN(pinnedAt.getTime())) {
      throw new Error(`Invalid time.options.at "${raw}" — expected an ISO instant.`);
    }
    // Captured per provider construction rather than at module load, so a
    // long-lived worker's second runtime does not inherit the first one's drift.
    const startedAt = Date.now();
    return {
      now: () => new Date(pinnedAt.getTime() + (Date.now() - startedAt)),
    };
  });
}

/** The `time` block for a generated `config.yaml`, or nothing when unpinned. */
export function timeConfigBlock(opts: {
  pinnedAt?: string | null;
  timeZone?: string;
}): Record<string, unknown> | undefined {
  if (opts.pinnedAt === null) return undefined;
  return {
    provider: "pinned",
    timezone: opts.timeZone ?? DEFAULT_TIMEZONE,
    options: { at: opts.pinnedAt ?? DEFAULT_PINNED_AT },
  };
}
