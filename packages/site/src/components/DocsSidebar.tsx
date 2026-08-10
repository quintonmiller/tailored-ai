"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { DOCS_NAV, DOCS_SEARCH_ITEMS } from "@/lib/constants";

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`docs-section-chevron${expanded ? " is-expanded" : ""}`}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="m5.5 3.5 4.5 4.5-4.5 4.5" />
    </svg>
  );
}

export function DocsSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const activeSectionId = DOCS_SEARCH_ITEMS.find((item) => item.href === pathname)?.sectionId ?? "start";
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set([activeSectionId]));
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    setExpandedSections((current) => {
      if (current.has(activeSectionId)) return current;
      return new Set([...current, activeSectionId]);
    });
  }, [activeSectionId]);

  const searchResults = normalizedQuery
    ? DOCS_SEARCH_ITEMS.filter((item) =>
        [item.label, item.description, item.sectionLabel, ...(item.keywords ?? [])]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : [];

  function toggleSection(sectionId: string) {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  }

  function closeAfterNavigation() {
    setOpen(false);
    setQuery("");
  }

  return (
    <>
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
        <div className="docs-filter">
          <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <circle cx="7.75" cy="7.75" r="4.75" />
            <path d="m11.25 11.25 3.5 3.5" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a page"
            aria-label="Search documentation pages"
          />
        </div>

        {normalizedQuery ? (
          <div className="docs-search-results" aria-live="polite">
            <div className="docs-search-summary">
              {searchResults.length} {searchResults.length === 1 ? "result" : "results"}
            </div>
            {searchResults.length > 0 ? (
              <ul>
                {searchResults.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={closeAfterNavigation}
                        aria-current={active ? "page" : undefined}
                        className={active ? "is-active" : undefined}
                      >
                        <span>{item.label}</span>
                        <small>{item.sectionLabel}</small>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="docs-filter-empty">No page matches “{query.trim()}”.</p>
            )}
          </div>
        ) : (
          <div className="docs-sections">
            {DOCS_NAV.map((section) => {
              const expanded = expandedSections.has(section.id);
              const controlsId = `docs-section-${section.id}`;
              return (
                <section key={section.id} className="docs-section">
                  <button
                    type="button"
                    className="docs-section-button"
                    onClick={() => toggleSection(section.id)}
                    aria-expanded={expanded}
                    aria-controls={controlsId}
                  >
                    <span>
                      <strong>{section.label}</strong>
                      <small>{section.description}</small>
                    </span>
                    <Chevron expanded={expanded} />
                  </button>
                  {expanded ? (
                    <ul id={controlsId} className="docs-section-links">
                      {section.items.map((item) => {
                        const active = pathname === item.href;
                        return (
                          <li key={item.href}>
                            <Link
                              href={item.href}
                              onClick={closeAfterNavigation}
                              aria-current={active ? "page" : undefined}
                              className={active ? "is-active" : undefined}
                            >
                              {item.label}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </nav>
    </>
  );
}
