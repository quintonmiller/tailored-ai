/**
 * The Memory page's archive: hidden by default, shown on request with when,
 * who and why, and Archive / Restore beside Delete for notes and facts.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Memory } from "./Memory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const note = (id: string, content: string, archived?: { by: string; reason: string }) => ({
  id,
  session_id: null,
  project_id: null,
  agent: "assistant",
  content,
  tags: [],
  importance: null,
  ref_count: 0,
  created_at: "2026-10-18 09:00:00",
  ttl_at: null,
  kept: false,
  archived_at: archived ? "2026-10-19 09:00:00" : null,
  archived_by: archived?.by ?? null,
  archive_reason: archived?.reason ?? null,
});
const fact = (id: string, value: string, archivedAt: string | null = null) => ({
  id,
  category: "person",
  entity: "alice",
  key: id,
  value,
  asof: null,
  source: null,
  confidence: null,
  project_id: null,
  created_at: "2026-10-18 09:00:00",
  updated_at: "2026-10-18 09:00:00",
  archived_at: archivedAt,
  archived_by: archivedAt ? "owner" : null,
  archive_reason: null,
});

let root: Root;
let container: HTMLDivElement;
const calls: { method: string; url: string; body?: unknown }[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const archived = url.includes("includeArchived=1");
      if (method === "POST") return new Response(JSON.stringify({}));
      if (url.startsWith("/api/memory/notes")) {
        const live = note("note_live", "the ferry runs hourly");
        const gone = note("note_gone", "the ferry is cancelled", { by: "sweep", reason: "expired" });
        return new Response(JSON.stringify(archived ? [live, gone] : [live]));
      }
      if (url.startsWith("/api/memory/stats")) {
        return new Response(
          JSON.stringify({
            counts: { notes: 1, facts: 1, sessionSummaries: 0, chunks: 0, archivedNotes: 1, archivedFacts: 1 },
            topReferenced: [],
            embeddingsEnabled: false,
            embeddingModel: null,
          }),
        );
      }
      if (url.startsWith("/api/facts")) {
        const facts = [fact("city", "Lisbon")];
        if (archived) facts.push(fact("phone", "123", "2026-10-19 09:00:00"));
        return new Response(JSON.stringify({ facts }));
      }
      return new Response("{}");
    }),
  );
  vi.stubGlobal(
    "prompt",
    vi.fn(() => "moved"),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(<Memory />);
  });
  for (let i = 0; i < 3; i++) await act(async () => {});
}

const noteRows = () => [...container.querySelectorAll(".memory-note")];
const buttonIn = (el: Element, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement | undefined;
const toggle = () => container.querySelector(".memory-archived-toggle input") as HTMLInputElement;

describe("Memory page archive", () => {
  it("hides archived notes until asked, then marks them with when, who and why", async () => {
    await render();
    expect(noteRows().map((r) => r.querySelector(".memory-note-content")?.textContent)).toEqual([
      "the ferry runs hourly",
    ]);
    expect(container.querySelector(".memory-archived-toggle")?.textContent).toContain("Show archived (2)");

    await act(async () => toggle().click());
    for (let i = 0; i < 3; i++) await act(async () => {});

    expect(calls.some((c) => c.url.startsWith("/api/memory/notes?") && c.url.includes("includeArchived=1"))).toBe(true);
    const archivedRow = noteRows().find((r) => r.className.includes("memory-note-archived"));
    expect(archivedRow?.textContent).toContain("the ferry is cancelled");
    expect(archivedRow?.querySelector(".memory-archived-stamp")?.textContent).toMatch(/Archived .* by sweep: expired/);
    expect(buttonIn(archivedRow!, "Restore")).toBeDefined();
    expect(buttonIn(archivedRow!, "Pin")).toBeUndefined();
    expect(container.textContent).toContain("Archived — hidden from agents");
  });

  it("archives a note with the reason asked for, and restores an archived one", async () => {
    await render();
    await act(async () => buttonIn(noteRows()[0], "Archive")!.click());
    expect(calls).toContainEqual({
      method: "POST",
      url: "/api/memory/notes/note_live/archive",
      body: { reason: "moved" },
    });

    await act(async () => toggle().click());
    for (let i = 0; i < 3; i++) await act(async () => {});
    const archivedRow = noteRows().find((r) => r.className.includes("memory-note-archived"))!;
    await act(async () => buttonIn(archivedRow, "Restore")!.click());
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/memory/notes/note_gone/unarchive")).toBe(true);
  });

  it("does nothing when the reason prompt is cancelled", async () => {
    vi.stubGlobal(
      "prompt",
      vi.fn(() => null),
    );
    await render();
    await act(async () => buttonIn(noteRows()[0], "Archive")!.click());
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("archives and restores facts the same way", async () => {
    await render();
    const live = container.querySelector(".memory-fact")!;
    await act(async () => buttonIn(live, "Archive")!.click());
    expect(calls).toContainEqual({ method: "POST", url: "/api/facts/city/archive", body: { reason: "moved" } });

    await act(async () => toggle().click());
    for (let i = 0; i < 3; i++) await act(async () => {});
    const archived = container.querySelector(".memory-fact-archived")!;
    expect(archived.textContent).toContain("Archived");
    await act(async () => buttonIn(archived, "Restore")!.click());
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/facts/phone/unarchive")).toBe(true);
  });
});
