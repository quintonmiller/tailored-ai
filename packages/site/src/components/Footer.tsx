import Link from "next/link";
import { REPO_URL, SITE_NAME } from "@/lib/constants";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-shell footer-grid">
        <div>
          <div className="footer-brand">{SITE_NAME}</div>
          <p>Open-source infrastructure for personal agents.</p>
        </div>
        <nav aria-label="Footer navigation">
          <Link href="/docs">Documentation</Link>
          <Link href="/bench">Benchmark</Link>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href="https://quinton.dev" target="_blank" rel="noopener noreferrer">
            Quinton Miller ↗
          </a>
        </nav>
        <div className="footer-meta">
          <span>MIT licensed</span>
          <span>Built in public</span>
        </div>
      </div>
    </footer>
  );
}
