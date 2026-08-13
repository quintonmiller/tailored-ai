/**
 * The furniture both demonstration pages share.
 *
 * Kept together so the two pages read as one family: the same section rhythm,
 * the same way of stating a number next to the thing it describes, the same
 * treatment for an agent's name wherever it appears.
 */

import Link from "next/link";
import type { AgentColour } from "@/lib/demo";

export function DemoHeader({
  eyebrow,
  title,
  standfirst,
  facts,
}: {
  eyebrow: string;
  title: string;
  standfirst: string;
  facts: Array<{ label: string; value: string; tone?: "good" | "muted" | "accent" }>;
}) {
  return (
    <header className="mb-12">
      <Link
        href="/bench"
        prefetch={false}
        className="text-sm text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-accent)]"
      >
        ← Benchmark
      </Link>
      <p className="mt-6 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--color-accent)]">{eyebrow}</p>
      <h1 className="mt-2 text-4xl font-bold tracking-tight text-balance">{title}</h1>
      <p className="mt-4 max-w-2xl text-lg leading-relaxed text-[var(--color-text-muted)]">{standfirst}</p>
      <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-5 border-t border-[var(--color-border)] pt-6 sm:grid-cols-4">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{fact.label}</dt>
            <dd
              className={`mt-1 font-mono text-lg tabular-nums ${
                fact.tone === "good"
                  ? "text-emerald-400"
                  : fact.tone === "accent"
                    ? "text-[var(--color-accent)]"
                    : fact.tone === "muted"
                      ? "text-[var(--color-text-muted)]"
                      : "text-[var(--color-text)]"
              }`}
            >
              {fact.value}
            </dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

export function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-16 scroll-mt-24">
      <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
      {lede && <div className="mt-3 max-w-2xl leading-relaxed text-[var(--color-text-muted)]">{lede}</div>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

export function AgentChip({ name, colour, subtitle }: { name: string; colour?: AgentColour; subtitle?: string }) {
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 rounded-md border px-2 py-0.5 font-mono text-xs ${
        colour
          ? `${colour.soft} ${colour.border} ${colour.text}`
          : "border-[var(--color-border)] text-[var(--color-text-muted)]"
      }`}
    >
      {name}
      {subtitle && <span className="text-[10px] opacity-70">{subtitle}</span>}
    </span>
  );
}

export function Legend({
  agents,
  colours,
  roles,
}: {
  agents: string[];
  colours: Map<string, AgentColour>;
  roles?: Record<string, string>;
}) {
  const roleOf = new Map(Object.entries(roles ?? {}).map(([role, agent]) => [agent, role]));
  return (
    <div className="flex flex-wrap gap-2">
      {agents.map((agent) => (
        <AgentChip key={agent} name={agent} colour={colours.get(agent)} subtitle={roleOf.get(agent)} />
      ))}
    </div>
  );
}

/**
 * A pull-quote for the finding a section exists to deliver.
 *
 * These pages are read by people deciding whether the benchmark measures
 * anything, and the answer is usually one sentence buried under a chart.
 */
export function Finding({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-6 border-l-2 border-[var(--color-accent)] pl-4 text-lg leading-relaxed text-[var(--color-text)] text-pretty">
      {children}
    </p>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--color-text-muted)] text-pretty">{children}</p>
  );
}
