import { FEATURES } from "@/lib/constants";

export function Features() {
  return (
    <section className="py-20">
      <div className="mx-auto max-w-6xl px-6">
        <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
          Six things TAI does that a chat box doesn&apos;t.
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-[var(--color-text-muted)]">
          A configurable agent runtime, not a wrapper around someone else&apos;s chatbot.
        </p>

        <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 transition-colors hover:border-[var(--color-text-muted)]"
            >
              <h3 className="text-lg font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm text-[var(--color-text-muted)] leading-relaxed">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
