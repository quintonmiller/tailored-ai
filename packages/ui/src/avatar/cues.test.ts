/**
 * Each cue plays with the sentence it came before, a cue after the last
 * sentence once the speech is over, and nothing survives the person cutting in.
 */
import { describe, expect, it } from "vitest";
import { CueTimeline } from "./cues";

function timeline() {
  const played: string[] = [];
  return { t: new CueTimeline((c) => played.push(c.target ? `${c.name}:${c.target}` : c.name)), played };
}

describe("CueTimeline", () => {
  it("plays a cue as the sentence it came before starts", () => {
    const { t, played } = timeline();
    t.cue({ name: "wave", seq: 1 });
    t.started(0);
    expect(played).toEqual([]);
    t.started(1);
    expect(played).toEqual(["wave"]);
  });

  it("plays a cue after the last sentence once the speech is over", () => {
    const { t, played } = timeline();
    t.cue({ name: "go", target: "the couch", seq: 1 });
    t.started(0);
    t.finished();
    expect(played).toEqual([]);
    t.quiet();
    expect(played).toEqual(["go:the couch"]);
  });

  it("plays at once when the reply was only cues", () => {
    const { t, played } = timeline();
    t.cue({ name: "go", target: "the desk", seq: 0 });
    t.finished();
    expect(played).toEqual(["go:the desk"]);
  });

  it("plays a cue whose sentence never played along with the next one that does", () => {
    const { t, played } = timeline();
    t.cue({ name: "nod", seq: 0 });
    t.cue({ name: "wave", seq: 1 });
    t.started(1);
    expect(played).toEqual(["nod", "wave"]);
  });

  it("drops what is still waiting when the person cuts in", () => {
    const { t, played } = timeline();
    t.cue({ name: "bow", seq: 2 });
    t.started(0);
    t.reset();
    t.quiet();
    t.finished();
    expect(played).toEqual([]);
  });
});
