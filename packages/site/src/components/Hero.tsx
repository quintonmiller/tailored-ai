import Link from "next/link";
import { REPO_URL } from "@/lib/constants";

export function Hero() {
  return (
    <section className="relative overflow-hidden py-24 sm:py-32">
      {/* Gradient background glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-[500px] w-[800px] rounded-full bg-[var(--color-accent)] opacity-[0.07] blur-[120px]" />
      </div>

      <div className="relative mx-auto max-w-4xl px-6 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl leading-[1.15]">
          Your{" "}
          <span className="bg-gradient-to-r from-[var(--color-accent)] via-purple-400 to-pink-400 bg-clip-text text-transparent">
            Agent.
          </span>
          {" "}Your{" "}
          <span className="bg-gradient-to-r from-[var(--color-accent)] via-purple-400 to-pink-400 bg-clip-text text-transparent">
            Tools.
          </span>
          <br />
          Your{" "}
          <span className="bg-gradient-to-r from-[var(--color-accent)] via-purple-400 to-pink-400 bg-clip-text text-transparent">
            Rules.
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-lg text-[var(--color-text-muted)] sm:text-xl">
          A configurable AI agent that works the way you want — locally, in the cloud, or both. Always running, always
          yours.
        </p>

        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <Link
            href="/docs/getting-started"
            className="rounded-lg bg-[var(--color-accent)] px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)]"
          >
            Get Started
          </Link>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-[var(--color-border)] px-6 py-3 text-sm font-medium text-[var(--color-text)] transition-colors hover:border-[var(--color-text-muted)]"
          >
            View on GitHub
          </a>
        </div>

        <div className="mt-12">
          <div className="mx-auto max-w-lg rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4 text-left font-mono text-sm text-[var(--color-text-muted)]">
            <span className="text-[var(--color-accent)]">$</span> npm install -g tailored-ai
            <br />
            <span className="text-[var(--color-accent)]">$</span> tai -m &quot;Hello, agent&quot;
          </div>
        </div>
      </div>
    </section>
  );
}
