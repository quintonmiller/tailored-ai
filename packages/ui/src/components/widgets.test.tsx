/**
 * The Board's recent-activity widget, as the run store sends its runs: each
 * by its agent's name, at its time on your clock. The dashboard panel in the
 * 3D world draws the same widget.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetCard } from "./widgets";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // On a clock off UTC, where a UTC time read as local is hours out: CI's is on UTC, where it would be right by chance.
  vi.stubEnv("TZ", "America/New_York");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the activity widget", () => {
  it("names each run's agent and gives its time on your clock, from the run store's UTC", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ runs: [{ agent_name: "scout", started_at: "2026-10-19 12:00:00", status: "noop" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await act(async () => {
      root.render(<WidgetCard widget={{ id: "runs", type: "activity", title: "Recent agent activity" }} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const run = container.querySelector(".widget-run");
    expect(run?.querySelector(".widget-run-agent")?.textContent).toBe("scout");
    const noon = new Date(Date.UTC(2026, 9, 19, 12)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(noon).toMatch(/^0?8:00/);
    expect(run?.querySelector(".widget-run-when")?.textContent).toBe(noon);
  });
});
