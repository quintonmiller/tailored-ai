"use client";

import Link from "next/link";
import { useState } from "react";
import { NAV_LINKS, REPO_URL, SITE_NAME } from "@/lib/constants";

function Mark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="site-shell flex h-[72px] items-center justify-between">
        <Link href="/" className="brand" aria-label={`${SITE_NAME} home`}>
          <Mark />
          <span>{SITE_NAME}</span>
        </Link>

        <nav className="hidden items-center gap-7 md:flex" aria-label="Main navigation">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="nav-link">
              {link.label}
            </Link>
          ))}
          <span className="h-4 w-px bg-[var(--color-border)]" aria-hidden="true" />
          <a className="github-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M5 11 11 5M6 5h5v5" />
            </svg>
          </a>
        </nav>

        <button
          type="button"
          className="menu-button md:hidden"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="mobile-navigation"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            {menuOpen ? <path d="M6 18L18 6M6 6l12 12" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
          </svg>
        </button>
      </div>

      {menuOpen && (
        <nav id="mobile-navigation" className="mobile-nav md:hidden" aria-label="Mobile navigation">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} onClick={() => setMenuOpen(false)}>
              {link.label}
            </Link>
          ))}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" onClick={() => setMenuOpen(false)}>
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </nav>
      )}
    </header>
  );
}
