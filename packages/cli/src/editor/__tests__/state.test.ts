import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../state.js";
import { defaultDraft } from "../types.js";

function state() {
  return initialState(defaultDraft("/home/test/.tai"));
}

describe("reducer toggleChannel", () => {
  it("toggles the built-in discord channel on and off", () => {
    let s = state();
    expect(s.draft.channels.discord).toBe(false);
    s = reducer(s, { type: "toggleChannel", channelId: "discord" });
    expect(s.draft.channels.discord).toBe(true);
    s = reducer(s, { type: "toggleChannel", channelId: "discord" });
    expect(s.draft.channels.discord).toBe(false);
  });

  it("toggles an arbitrary non-discord channel id, leaving discord untouched", () => {
    let s = state();
    s = reducer(s, { type: "toggleChannel", channelId: "slack" });
    expect(s.draft.channels.slack).toBe(true);
    // discord is untouched and still present
    expect(s.draft.channels.discord).toBe(false);
    s = reducer(s, { type: "toggleChannel", channelId: "slack" });
    expect(s.draft.channels.slack).toBe(false);
  });

  it("snapshots the previous draft so undo restores it", () => {
    let s = state();
    s = reducer(s, { type: "toggleChannel", channelId: "telegram" });
    expect(s.draft.channels.telegram).toBe(true);
    expect(s.previousDraft).toBeDefined();
    s = reducer(s, { type: "undo" });
    expect(s.draft.channels.telegram).toBeUndefined();
  });
});
