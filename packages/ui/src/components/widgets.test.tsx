/**
 * The Board's recent-activity widget, as the run store sends its runs: each
 * by its agent's name, at its time on your clock. The dashboard panel in the
 * 3D world draws the same widget.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardWidgetSpec } from "../api";
import { WidgetCard, widgetRenderers } from "./widgets";

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

describe("a widget drawn again", () => {
  it("starts from what its endpoint sent last, rather than loading from nothing", async () => {
    let answer: (r: Response) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise<Response>((done) => {
          answer = done;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const health = { id: "health", type: "status", title: "System status", options: { endpoint: "/api/health?seen" } };
    await act(async () => {
      root.render(<WidgetCard widget={health} />);
    });
    expect(container.textContent).toContain("Starting");
    await act(async () => {
      answer(
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain("Online");
    // Drawn again from nothing (a screen in the 3D world coming near enough to read): online at once, while it asks.
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<WidgetCard widget={health} />);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Online");
    expect(container.textContent).not.toContain("Starting");
  });
});

describe("the clock widget", () => {
  it("ticks by the second on the Board, and only by the minute where told to leave the seconds off", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 9, 41, 7));
    const Clock = widgetRenderers.clock;
    const widget = { id: "clock", type: "clock" } as DashboardWidgetSpec;
    try {
      act(() => root.render(<Clock widget={widget} />));
      const time = () => container.querySelector(".widget-clock-time")?.textContent ?? "";
      const ticking = time();
      expect(ticking).toMatch(/07/);
      act(() => vi.advanceTimersByTime(1000));
      expect(time()).not.toBe(ticking);
      // On a wall in the world, away from being read up close: the minute, its words left alone between minutes.
      act(() => root.render(<Clock widget={widget} seconds={false} />));
      const still = time();
      expect(still).not.toMatch(/:0?8\b/);
      const changes: MutationRecord[] = [];
      const watch = new MutationObserver((m) => changes.push(...m));
      watch.observe(container, { subtree: true, characterData: true, childList: true });
      act(() => vi.advanceTimersByTime(30_000));
      watch.disconnect();
      expect(time()).toBe(still);
      expect(changes).toEqual([]);
      act(() => vi.advanceTimersByTime(30_000));
      expect(time()).not.toBe(still);
    } finally {
      vi.useRealTimers();
    }
  });
});
