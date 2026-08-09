/**
 * One row per scenario, opening onto why it exists and what went wrong.
 *
 * The intent is shown first when a row is opened, before any failure detail. A
 * failing check is only legible next to the thing the scenario was written to
 * catch — `does_not_post_in` failing means nothing until you know the scenario
 * exists because an agent once answered three people in the wrong room.
 *
 * Nothing here is a client component, and that is a deliberate constraint
 * rather than an accident. Rows open with `<details>`; the failures-only filter
 * is a checkbox and a sibling selector. So the whole run is in the exported
 * HTML exactly once, which means find-in-page searches every scenario — for a
 * room name, a passphrase, a phrase the model invented — rather than only the
 * rows somebody already clicked.
 */

import { formatNumber } from "@/lib/bench";
import { KnownGapChip, RateBadge, RateBar, toneFor } from "./Rate";

export interface CheckView {
  kind: string;
  pass: boolean;
  detail?: string;
  skipped?: boolean;
}

export interface RequestView {
  system: string;
  messages: Array<{ role: string; content: string }>;
  toolCount: number;
  estimatedTokens: number;
}

export interface RunView {
  pass: boolean;
  checks: CheckView[];
  reply: string;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  posts: Array<{ room: string; body: string }>;
  /** Present only on failing runs — a passing run's transcript is dead weight. */
  requests: RequestView[];
  latencyMs: number;
  retries?: number;
  providerErrors?: string[];
  error?: string;
}

export interface ScenarioView {
  id: string;
  category: string;
  intent: string;
  knownGap?: string;
  passRate: number;
  passed: number;
  total: number;
  error?: string;
  runs: RunView[];
}

const FILTER_ID = "bench-failures-only";

/** `<summary>` renders a disclosure triangle by default in every engine. */
const SUMMARY_RESET = "cursor-pointer list-none [&::-webkit-details-marker]:hidden";

function Chevron() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
      className="shrink-0 transition-transform group-open:rotate-90"
    >
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      {children}
    </div>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-bg)] p-3 font-mono text-xs leading-relaxed text-[var(--color-text)]">
      {children}
    </pre>
  );
}

function RequestPanel({ requests }: { requests: RequestView[] }) {
  if (!requests.length) return null;

  return (
    <details className="group">
      <summary
        className={`${SUMMARY_RESET} flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]`}
      >
        <Chevron />
        Assembled request
        <span className="font-normal normal-case tracking-normal opacity-70">
          {requests.length} call{requests.length === 1 ? "" : "s"} · {formatNumber(requests[0].estimatedTokens)} tokens
          · {requests[0].toolCount} tools
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {requests.map((request, index) => (
          // Requests are an ordered log of one turn; nothing else identifies them.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          <div key={index} className="space-y-2">
            <div className="text-[11px] text-[var(--color-text-muted)]">
              Call {index + 1} · {formatNumber(request.estimatedTokens)} tokens
            </div>
            {request.system && (
              <Block label="System">
                <Pre>{request.system}</Pre>
              </Block>
            )}
            {request.messages.map((message, messageIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
              <Block key={messageIndex} label={message.role}>
                <Pre>{message.content}</Pre>
              </Block>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

function RunPanel({ run, index, total }: { run: RunView; index: number; total: number }) {
  const failed = run.checks.filter((check) => !check.pass);

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold">
          Run {index + 1} of {total}
        </span>
        <span className={`font-mono text-xs ${run.pass ? "text-emerald-400" : "text-rose-400"}`}>
          {run.pass ? "passed" : "failed"}
        </span>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {(run.latencyMs / 1000).toFixed(1)}s
          {run.retries ? ` · ${run.retries} retr${run.retries === 1 ? "y" : "ies"}` : ""}
        </span>
      </div>

      <div className="space-y-4">
        {run.error && (
          <div className="rounded-md border border-rose-400/30 bg-rose-400/5 p-3 text-xs text-rose-300">
            {run.error}
          </div>
        )}

        {failed.length > 0 && (
          <Block label="Failed checks">
            <ul className="space-y-1.5">
              {failed.map((check, checkIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: checks have no id, and order is the record
                <li key={checkIndex} className="flex gap-2 text-xs [overflow-wrap:anywhere]">
                  <span className="shrink-0 font-mono text-rose-400">{check.kind}</span>
                  <span className="text-[var(--color-text-muted)]">{check.detail ?? "failed"}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        <Block label="Reply">
          {run.reply ? (
            <Pre>{run.reply}</Pre>
          ) : (
            <p className="text-xs italic text-[var(--color-text-muted)]">
              nothing was said — the turn produced no outward message
            </p>
          )}
        </Block>

        {run.calls.length > 0 && (
          <Block label={`Tool calls (${run.calls.length})`}>
            <ul className="space-y-1">
              {run.calls.map((call, callIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: call order is the record
                <li key={callIndex} className="font-mono text-xs [overflow-wrap:anywhere]">
                  <span className="text-[var(--color-accent-hover)]">{call.name}</span>
                  <span className="text-[var(--color-text-muted)]">({JSON.stringify(call.args)})</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {run.posts.length > 0 && (
          <Block label={`Posted (${run.posts.length})`}>
            <ul className="space-y-1.5">
              {run.posts.map((post, postIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: post order is the record
                <li key={postIndex} className="text-xs [overflow-wrap:anywhere]">
                  <span className="font-mono text-[var(--color-accent-hover)]">#{post.room}</span>{" "}
                  <span className="text-[var(--color-text-muted)]">{post.body}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}

        {run.providerErrors?.length ? (
          <Block label="Provider errors">
            <ul className="space-y-1">
              {run.providerErrors.map((message) => (
                <li key={message} className="font-mono text-xs text-amber-400 [overflow-wrap:anywhere]">
                  {message}
                </li>
              ))}
            </ul>
          </Block>
        ) : null}

        <RequestPanel requests={run.requests} />
      </div>
    </div>
  );
}

function ScenarioRow({ scenario, hideWhenFiltered }: { scenario: ScenarioView; hideWhenFiltered: boolean }) {
  const tone = toneFor(scenario.passRate, scenario.knownGap);

  return (
    <details
      className="bench-row group border-t border-[var(--color-bg-tertiary)] first-of-type:border-t-0"
      data-passing={hideWhenFiltered ? "true" : "false"}
    >
      <summary
        className={`${SUMMARY_RESET} flex w-full items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-bg-secondary)]`}
      >
        <span className="text-[var(--color-text-muted)]">
          <Chevron />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{scenario.id}</span>
            {scenario.knownGap && <KnownGapChip gap={scenario.knownGap} />}
          </span>
          <span className="mt-0.5 block text-[11px] text-[var(--color-text-muted)]">{scenario.category}</span>
        </span>
        <RateBar rate={scenario.passRate} tone={tone} />
        <span className="w-20 shrink-0 text-right">
          <RateBadge passed={scenario.passed} runs={scenario.total} knownGap={scenario.knownGap} />
        </span>
      </summary>

      <div className="space-y-4 border-t border-[var(--color-bg-tertiary)] bg-[var(--color-bg)] px-4 py-4">
        <Block label="Why this scenario exists">
          <p className="max-w-3xl whitespace-pre-line text-sm leading-relaxed text-[var(--color-text-muted)]">
            {scenario.intent}
          </p>
        </Block>

        {scenario.knownGap && (
          <div className="rounded-md border border-sky-400/30 bg-sky-400/5 p-3 text-sm text-sky-200">
            <span className="font-semibold">Expected to be red. </span>
            {scenario.knownGap}
          </div>
        )}

        {scenario.error && (
          <div className="rounded-md border border-rose-400/30 bg-rose-400/5 p-3 text-xs text-rose-300">
            {scenario.error}
          </div>
        )}

        <div className="space-y-3">
          {scenario.runs.map((run, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: runs are ordered repeats, nothing else names them
            <RunPanel key={index} run={run} index={index} total={scenario.runs.length} />
          ))}
        </div>
      </div>
    </details>
  );
}

export function ScenarioList({ scenarios }: { scenarios: ScenarioView[] }) {
  const failing = scenarios.filter((scenario) => scenario.passRate < 1).length;

  return (
    // `.bench-scenarios` and `.bench-row` are paired by one rule in globals.css:
    // checking the box hides every row marked `data-passing`. Written as CSS
    // rather than state so the filter costs no JavaScript and no second copy of
    // the run in the page payload.
    <div className="bench-scenarios overflow-hidden rounded-xl border border-[var(--color-border)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-4 py-3">
        <p className="text-sm text-[var(--color-text-muted)]">
          {scenarios.length} scenarios ·{" "}
          {failing === 0 ? "every one passed every run" : `${failing} did not pass every run`}
        </p>
        {failing > 0 && (
          <label
            htmlFor={FILTER_ID}
            className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            <input type="checkbox" id={FILTER_ID} className="bench-filter h-3.5 w-3.5 accent-[var(--color-accent)]" />
            Only those with failures
          </label>
        )}
      </div>

      {scenarios.map((scenario) => (
        <ScenarioRow key={scenario.id} scenario={scenario} hideWhenFiltered={scenario.passRate >= 1} />
      ))}
    </div>
  );
}
