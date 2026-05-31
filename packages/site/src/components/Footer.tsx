import { REPO_URL, SITE_NAME } from "@/lib/constants";

export function Footer() {
  return (
    <footer className="border-t border-[var(--color-border)] py-8">
      <div className="mx-auto max-w-6xl px-6 flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
        <p className="text-sm text-[var(--color-text-muted)]">
          {SITE_NAME} &mdash; Built by{" "}
          <a
            href="https://quinton.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-accent)] hover:text-[var(--color-accent-hover)]"
          >
            Quinton Miller
          </a>
        </p>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          GitHub
        </a>
      </div>
    </footer>
  );
}
