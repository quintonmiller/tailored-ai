/**
 * What a run was, stated next to what it scored.
 *
 * Provenance is not decoration here. Two runs are comparable only if the
 * scenario set, the commit, the repeat count and the client line up, so these
 * fields are rendered at the same weight as the score rather than tucked into
 * a footer. A number whose conditions are one click away gets compared to
 * numbers it has no business being compared to.
 */

import { formatDate, formatDuration } from "@/lib/bench";
import type { ReportMeta } from "@/lib/bench-types";
import { REPO_URL } from "@/lib/constants";

function Field({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-xs text-[var(--color-text)]">{children}</dd>
    </div>
  );
}

export function Provenance({ meta }: { meta: ReportMeta }) {
  const client = meta.provider ?? "openai_compatible";
  const via = meta.plugins?.length ? meta.plugins.join(", ") : null;

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
      <Field label="Model">{meta.model}</Field>

      <Field label="Client" title={via ? `supplied by ${via}` : "core's built-in OpenAI-compatible client"}>
        {client}
      </Field>

      <Field label="Commit" title={meta.gitDirty ? "the working tree had uncommitted changes" : undefined}>
        <a
          href={`${REPO_URL}/commit/${meta.gitSha}`}
          className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)] hover:underline"
        >
          {meta.gitSha}
        </a>
        {meta.gitDirty && <span className="ml-1.5 text-amber-400">+uncommitted</span>}
      </Field>

      <Field
        label="Scenario set"
        title="A hash of every scenario file. Runs with different hashes asked different questions."
      >
        {meta.scenarioSetHash}
      </Field>

      <Field label="Repeats" title="Each scenario ran this many times; the score is the mean pass rate.">
        {meta.repeats}×{meta.seed === null ? "" : ` seed ${meta.seed}`}
      </Field>

      <Field label="Run">
        {formatDate(meta.startedAt)}
        <span className="ml-1.5 text-[var(--color-text-muted)]">{formatDuration(meta.durationSeconds)}</span>
      </Field>
    </dl>
  );
}

/** The comparability guards, surfaced rather than left for the reader to reconstruct. */
export function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
        Read this before comparing
      </div>
      <ul className="space-y-2">
        {warnings.map((warning) => (
          <li key={warning} className="text-sm leading-relaxed text-[var(--color-text-muted)]">
            {warning}
          </li>
        ))}
      </ul>
    </div>
  );
}
