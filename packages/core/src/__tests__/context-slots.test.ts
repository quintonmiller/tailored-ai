/**
 * Contributing a block of context without knowing the layout.
 *
 * The existing seam could express any layout but demanded you understand the
 * whole one: a custom layer only rendered if you also enumerated every built-in
 * in `order`, and setting `order` switched off the tail. A slot is the other
 * half — the author says what they have and how it behaves, core decides where
 * it goes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ContextSlot,
  type ContextSlotContext,
  capSlot,
  clearContextSlots,
  listContextSlots,
  registerContextSlot,
  renderContextSlots,
  resetContextSlotWarnings,
  slotsFromConfig,
  unregisterContextSlot,
} from "../agent/context-slots.js";

const ctx: ContextSlotContext = {
  agent: "coder",
  projectId: null,
  sessionId: "s1",
  userMessage: "go",
};

function slot(over: Partial<ContextSlot> & Pick<ContextSlot, "id" | "refresh">): ContextSlot {
  return { render: () => "content", ...over };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearContextSlots();
  resetContextSlotWarnings();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  clearContextSlots();
  warnSpy.mockRestore();
});

describe("registration", () => {
  it("replaces a slot re-registered under the same id", () => {
    registerContextSlot(slot({ id: "a", refresh: "turn", render: () => "first" }));
    registerContextSlot(slot({ id: "a", refresh: "turn", render: () => "second" }));

    // A plugin reloaded at runtime must not end up contributing twice.
    expect(listContextSlots()).toHaveLength(1);
    expect(renderContextSlots(ctx).turn).toContain("second");
    expect(renderContextSlots(ctx).turn).not.toContain("first");
  });

  it("refuses a refresh value that is not a placement decision", () => {
    expect(() => registerContextSlot(slot({ id: "a", refresh: "later" as never }))).toThrow(/expected/);
  });

  it("refuses an unnamed slot", () => {
    expect(() => registerContextSlot(slot({ id: "", refresh: "turn" }))).toThrow(/id/);
  });

  it("unregisters", () => {
    registerContextSlot(slot({ id: "a", refresh: "turn" }));
    expect(unregisterContextSlot("a")).toBe(true);
    expect(listContextSlots()).toHaveLength(0);
  });
});

describe("placement follows refresh, and nothing else", () => {
  it("puts standing knowledge in the prompt group and per-turn state in the tail group", () => {
    registerContextSlot(slot({ id: "rules", refresh: "reload", render: () => "house rules" }));
    registerContextSlot(slot({ id: "oncall", refresh: "turn", render: () => "alex is on call" }));

    const out = renderContextSlots(ctx);

    expect(out.reload).toContain("house rules");
    expect(out.reload).not.toContain("on call");
    expect(out.turn).toContain("alex is on call");
    expect(out.turn).not.toContain("house rules");
  });

  it("renders every per-turn slot into one block", () => {
    registerContextSlot(slot({ id: "a", refresh: "turn", render: () => "first" }));
    registerContextSlot(slot({ id: "b", refresh: "turn", render: () => "second" }));

    // One contiguous block is a hard requirement, not a style choice: the
    // Anthropic history cache breakpoint targets `messages.length - 2` and so
    // assumes exactly one volatile trailing message.
    const out = renderContextSlots(ctx);
    expect(out.turn).toContain("first");
    expect(out.turn).toContain("second");
  });

  it("is empty when nothing applies, so callers can skip the block", () => {
    expect(renderContextSlots(ctx)).toEqual({ reload: "", turn: "", rendered: [] });
  });
});

describe("a slot decides not to render", () => {
  it("skips null", () => {
    registerContextSlot(slot({ id: "a", refresh: "turn", render: () => null }));
    expect(renderContextSlots(ctx).turn).toBe("");
  });

  it("skips empty output rather than emitting a bare heading", () => {
    registerContextSlot(slot({ id: "a", refresh: "turn", title: "On call", render: () => "" }));
    expect(renderContextSlots(ctx).turn).toBe("");
  });
});

describe("a slot that misbehaves does not cost the turn", () => {
  it("skips a thrower and keeps the others", () => {
    registerContextSlot(
      slot({
        id: "bad",
        refresh: "turn",
        render: () => {
          throw new Error("boom");
        },
      }),
    );
    registerContextSlot(slot({ id: "good", refresh: "turn", render: () => "still here" }));

    expect(renderContextSlots(ctx).turn).toContain("still here");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Slot "bad" threw'));
  });

  it("warns once, not once per turn", () => {
    registerContextSlot(
      slot({
        id: "bad",
        refresh: "turn",
        render: () => {
          throw new Error("boom");
        },
      }),
    );
    for (let i = 0; i < 5; i++) renderContextSlots(ctx);

    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('"bad"'))).toHaveLength(1);
  });
});

describe("agent scoping", () => {
  it("shows a slot to the agents it names", () => {
    registerContextSlot(slot({ id: "a", refresh: "turn", agents: ["coder"], render: () => "for coder" }));
    expect(renderContextSlots(ctx).turn).toContain("for coder");
  });

  it("hides it from an agent it does not", () => {
    registerContextSlot(slot({ id: "a", refresh: "turn", agents: ["planner"], render: () => "for planner" }));
    expect(renderContextSlots({ ...ctx, agent: "coder" }).turn).toBe("");
  });

  it("treats the wildcard and an absent list the same", () => {
    registerContextSlot(slot({ id: "a", refresh: "turn", agents: ["*"], render: () => "everyone" }));
    registerContextSlot(slot({ id: "b", refresh: "turn", render: () => "also everyone" }));

    const out = renderContextSlots({ ...ctx, agent: "anyone" }).turn;
    expect(out).toContain("everyone");
    expect(out).toContain("also everyone");
  });
});

describe("budgets are core's job", () => {
  it("leaves content under budget alone", () => {
    expect(capSlot("short", 100)).toBe("short");
  });

  it("says that it truncated, rather than truncating quietly", () => {
    const out = capSlot("x".repeat(1000), 10);
    // Silent truncation is the failure this whole area keeps producing: the
    // model reads what survived as the whole of it.
    expect(out).toContain("truncated to fit");
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it("treats an omitted budget as uncapped", () => {
    const long = "x".repeat(5000);
    expect(capSlot(long, undefined)).toBe(long);
  });

  it("applies the budget through the renderer", () => {
    registerContextSlot(slot({ id: "a", refresh: "turn", budgetTokens: 5, render: () => "y".repeat(1000) }));
    expect(renderContextSlots(ctx).turn).toContain("truncated to fit");
  });
});

describe("config-declared slots", () => {
  const read = (path: string) =>
    path === "/ok.md"
      ? "from disk"
      : (() => {
          throw new Error("ENOENT");
        })();

  it("renders inline content", () => {
    const built = slotsFromConfig([{ id: "a", refresh: "reload", content: "inline" }], read);
    expect(renderContextSlots(ctx, built).reload).toContain("inline");
  });

  it("reads a file fresh, so an edit lands without a restart", () => {
    let contents = "first";
    const built = slotsFromConfig([{ id: "a", refresh: "turn", file: "/x.md" }], () => contents);

    expect(renderContextSlots(ctx, built).turn).toContain("first");
    contents = "second";
    expect(renderContextSlots(ctx, built).turn).toContain("second");
  });

  it("survives a missing file", () => {
    const built = slotsFromConfig([{ id: "a", refresh: "turn", file: "/missing.md" }], read);
    // A file an operator has not created yet must not be the reason an agent
    // cannot answer.
    expect(renderContextSlots(ctx, built).turn).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Slot "a" threw'));
  });

  it("prefers inline content over a file", () => {
    const built = slotsFromConfig([{ id: "a", refresh: "turn", content: "inline", file: "/ok.md" }], read);
    expect(renderContextSlots(ctx, built).turn).toContain("inline");
    expect(renderContextSlots(ctx, built).turn).not.toContain("from disk");
  });

  it("renders a title as a heading", () => {
    const built = slotsFromConfig([{ id: "a", refresh: "turn", title: "On call", content: "alex" }], read);
    expect(renderContextSlots(ctx, built).turn).toContain("## On call");
  });
});
