import Link from "next/link";
import { Features } from "@/components/Features";
import { Hero } from "@/components/Hero";

export default function Home() {
  return (
    <>
      <Hero />
      <Features />

      {/* CTA */}
      <section className="py-20">
        <div className="mx-auto max-w-4xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Get started in minutes</h2>
          <p className="mx-auto mt-4 max-w-xl text-[var(--color-text-muted)]">
            One install. One config file. An AI agent that works the way you want.
          </p>
          <div className="mt-8">
            <Link
              href="/docs/getting-started"
              className="rounded-lg bg-[var(--color-accent)] px-8 py-3 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)]"
            >
              Read the Docs
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
