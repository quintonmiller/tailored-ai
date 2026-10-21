import { afterEach, describe, expect, it, vi } from "vitest";
import { changeBody } from "./body";

/** A server holding one body record, answering the page's reads and writes and remembering the writes. */
function serve(record: Record<string, unknown> | null) {
  const writes: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method)
        return record
          ? new Response(JSON.stringify(record))
          : new Response(JSON.stringify({ error: "No body record" }), { status: 404 });
      writes.push({ method: init.method, url, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return new Response("{}");
    }),
  );
  return writes;
}

afterEach(() => vi.unstubAllGlobals());

describe("changing an agent's body from the page", () => {
  it("starts from what the body chose, and writes at its version", async () => {
    const writes = serve({ data: { color: "#e0457b", walk: "sneak" }, version: 4 });
    await changeBody("planner", { idle: "calm" });
    expect(writes).toEqual([
      {
        method: "PUT",
        url: "/api/state/body/planner",
        body: { scope: "agent:planner", data: { color: "#e0457b", walk: "sneak", idle: "calm" }, expectedVersion: 4 },
      },
    ]);
  });

  it("starts from nothing over an archived body, as the agent's own tool does, and writes over it at its version", async () => {
    const archived = { data: { color: "#e0457b", walk: "sneak" }, version: 4, archivedAt: "2026-10-20T10:00:00Z" };
    const writes = serve(archived);
    await changeBody("planner", { idle: "calm" });
    expect(writes).toEqual([
      {
        method: "PUT",
        url: "/api/state/body/planner",
        body: { scope: "agent:planner", data: { idle: "calm" }, expectedVersion: 4 },
      },
    ]);
    // Clearing a choice it no longer has in effect leaves the archived record as it is, rather than deleting it.
    const none = serve(archived);
    await changeBody("planner", { color: null });
    expect(none).toEqual([]);
  });
});
