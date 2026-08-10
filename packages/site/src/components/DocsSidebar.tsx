"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { DOCS_NAV } from "@/lib/constants";

export function DocsSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        type="button"
        className="docs-menu-button flex w-full items-center gap-2 lg:hidden"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="docs-navigation"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          {open ? <path d="M3 3l10 10M13 3 3 13" /> : <path d="M2 4h12M2 8h12M2 12h12" />}
        </svg>
        <span>Documentation</span>
        <span className="docs-menu-state">{open ? "Close" : "Browse"}</span>
      </button>

      <nav
        id="docs-navigation"
        aria-label="Documentation"
        className={`${open ? "mt-4 block" : "hidden"} lg:mt-0 lg:block`}
      >
        <div className="space-y-6">
          {DOCS_NAV.map((section) => (
            <div key={section.label}>
              <div className="px-3 mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                {section.label}
              </div>
              <ul className="space-y-1">
                {section.items.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        aria-current={active ? "page" : undefined}
                        className={`block rounded-md px-3 py-2 text-sm transition-colors ${
                          active
                            ? "bg-[var(--color-accent)]/10 text-[var(--color-accent)] font-medium"
                            : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                        }`}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}
