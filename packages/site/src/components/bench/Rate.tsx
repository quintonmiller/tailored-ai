/**
 * Rendering a pass rate.
 *
 * Every one of these shows the fraction as well as the percentage, on purpose.
 * A benchmark whose scenarios repeat produces rates, not verdicts, and two runs
 * in three is a different result from three in three — collapsing them to
 * "pass" is how a viewer stops noticing a model becoming less reliable.
 */

export type Tone = "good" | "mixed" | "bad" | "gap" | "absent";

const TONE_TEXT: Record<Tone, string> = {
  good: "text-emerald-400",
  mixed: "text-amber-400",
  bad: "text-rose-400",
  gap: "text-sky-400",
  absent: "text-[var(--color-text-muted)]",
};

const TONE_BAR: Record<Tone, string> = {
  good: "bg-emerald-400",
  mixed: "bg-amber-400",
  bad: "bg-rose-400",
  gap: "bg-sky-400",
  absent: "bg-[var(--color-border)]",
};

/**
 * The tone of a single scenario, where only "passed every time" is green.
 *
 * `knownGap` outranks the rate. A scenario that asserts the behaviour we want
 * rather than the behaviour we have is *supposed* to be red, and painting it
 * red alongside genuine failures invites someone to fix it by deleting it.
 */
export function toneFor(rate: number, knownGap?: string): Tone {
  if (knownGap) return "gap";
  if (rate >= 0.999) return "good";
  if (rate > 0) return "mixed";
  return "bad";
}

/**
 * The tone of a score averaged over many scenarios, which needs different
 * thresholds from a single one.
 *
 * Demanding 100% of an aggregate would paint every run amber and flatten the
 * difference between a healthy 97% and a struggling 91% — the two readings a
 * comparison page exists to separate. A benchmark with deliberately-red rows in
 * it can never reach 100% anyway.
 */
export function toneForAggregate(rate: number): Tone {
  if (rate >= 0.95) return "good";
  if (rate >= 0.8) return "mixed";
  return "bad";
}

export function RateBar({ rate, tone, width = 96 }: { rate: number; tone: Tone; width?: number }) {
  return (
    <div
      className="h-1.5 shrink-0 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]"
      style={{ width }}
      role="img"
      aria-label={`${Math.round(rate * 100)} percent`}
    >
      <div className={`h-full rounded-full ${TONE_BAR[tone]}`} style={{ width: `${Math.max(rate * 100, 0)}%` }} />
    </div>
  );
}

/** The fraction is the primary reading; the percentage is the gloss. */
export function RateBadge({ passed, runs, knownGap }: { passed: number; runs: number; knownGap?: string }) {
  if (runs === 0) {
    return <span className={`font-mono text-xs ${TONE_TEXT.absent}`}>no runs</span>;
  }
  const rate = passed / runs;
  const tone = toneFor(rate, knownGap);
  return (
    <span className={`font-mono text-xs tabular-nums ${TONE_TEXT[tone]}`}>
      {passed}/{runs}
      <span className="ml-1.5 opacity-60">{Math.round(rate * 100)}%</span>
    </span>
  );
}

/** A cell for a scenario the run never executed — distinct from one it failed. */
export function AbsentCell({ reason }: { reason: string }) {
  return (
    <span className="font-mono text-xs text-[var(--color-text-muted)] opacity-50" title={reason}>
      not run
    </span>
  );
}

export function KnownGapChip({ gap }: { gap: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium text-sky-300"
      title={gap}
    >
      known gap
    </span>
  );
}
