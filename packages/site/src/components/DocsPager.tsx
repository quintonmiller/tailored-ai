"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_NAV } from "@/lib/constants";

const pages = DOCS_NAV.flatMap((section) => section.items);

function Arrow({ direction }: { direction: "previous" | "next" }) {
  return (
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d={direction === "previous" ? "M14.25 9H3.75M8 4.75 3.75 9 8 13.25" : "M3.75 9h10.5M10 4.75 14.25 9 10 13.25"}
      />
    </svg>
  );
}

export function DocsPager() {
  const pathname = usePathname();
  const pageIndex = pages.findIndex((page) => page.href === pathname);

  if (pageIndex < 0) return null;

  const previous = pages[pageIndex - 1];
  const next = pages[pageIndex + 1];

  return (
    <nav className="docs-pager not-prose" aria-label="Documentation pages">
      {previous ? (
        <Link href={previous.href} className="docs-pager-link docs-pager-previous">
          <span className="docs-pager-direction">
            <Arrow direction="previous" /> Previous
          </span>
          <strong>{previous.label}</strong>
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}

      {next ? (
        <Link href={next.href} className="docs-pager-link docs-pager-next">
          <span className="docs-pager-direction">
            Next <Arrow direction="next" />
          </span>
          <strong>{next.label}</strong>
        </Link>
      ) : null}
    </nav>
  );
}
