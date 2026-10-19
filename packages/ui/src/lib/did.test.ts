/**
 * The words for what an agent did last and when it wakes: a status line
 * said as done, how long ago, and the time it next wakes.
 */
import { describe, expect, it } from "vitest";
import { aboutLines, asleepWords, lastDid, pastTense, TAG_LINE_CHARS, wakeWords } from "./did";

const now = Date.UTC(2026, 9, 19, 2, 0);
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const minutes = (n: number) => new Date(now - n * 60_000).toISOString();

describe("pastTense", () => {
  it("says the built-in tools' status lines as done", () => {
    expect(pastTense("searching the web")).toBe("searched the web");
    expect(pastTense("updating tasks")).toBe("updated tasks");
    expect(pastTense("rearranging the room")).toBe("rearranged the room");
    expect(pastTense("handing work to planner")).toBe("handed work to planner");
    expect(pastTense("talking in #trip")).toBe("talked in #trip");
    expect(pastTense("replying")).toBe("replied");
    expect(pastTense("browsing")).toBe("browsed");
  });

  it("knows the ones that don't end in -ed", () => {
    expect(pastTense("reading a page")).toBe("read a page");
    expect(pastTense("taking a photo")).toBe("took a photo");
    expect(pastTense("making a PDF")).toBe("made a PDF");
    expect(pastTense("going through documents")).toBe("went through documents");
    expect(pastTense("running commands")).toBe("ran commands");
    expect(pastTense("setting a reminder")).toBe("set a reminder");
  });

  it("leaves words that aren't doing words alone", () => {
    expect(pastTense("idle")).toBe("idle");
    expect(pastTense("string theory")).toBe("string theory");
    expect(pastTense("")).toBe("");
  });
});

describe("lastDid", () => {
  it("says what it did and how long ago", () => {
    expect(lastDid({ what: "searching the web", at: minutes(40) }, now)).toBe("searched the web, 40 min ago");
    expect(lastDid({ what: "replying", at: minutes(0) }, now)).toBe("replied, just now");
    expect(lastDid(undefined, now)).toBeUndefined();
  });

  it("cuts a long what to fit, keeping how long ago whole", () => {
    const long = { what: "talking in #draft-review-for-the-quarterly-newsletter", at: minutes(40) };
    const line = lastDid(long, now, 34);
    expect(line).toMatch(/…, 40 min ago$/);
    expect(line?.length).toBeLessThanOrEqual(34);
    expect(lastDid({ what: "searching the web", at: minutes(40) }, now, 34)).toBe("searched the web, 40 min ago");
  });
});

describe("wakeWords", () => {
  it("says a time today, a day and a time further off, or any minute now", () => {
    expect(wakeWords("2026-10-19T07:00:00Z", now, clock)).toBe("07:00");
    expect(wakeWords("2026-10-19T02:00:30Z", now, clock)).toBe("any minute now");
    expect(wakeWords("2026-10-21T07:00:00Z", now, clock)).toMatch(/^\S+ 07:00$/);
    expect(wakeWords(undefined, now, clock)).toBeUndefined();
  });

  it("says any minute now for a wake just gone, and nothing for one long gone", () => {
    expect(wakeWords("2026-10-19T01:59:30Z", now, clock)).toBe("any minute now");
    expect(wakeWords("2026-10-18T20:01:00Z", now, clock)).toBeUndefined();
  });
});

describe("aboutLines", () => {
  const last = { what: "searching the web", at: minutes(40) };
  it("says what an idle agent did last and when it wakes next", () => {
    expect(
      aboutLines({ agent: "planner", doing: "idle", what: "idle", last, next: "2026-10-19T07:00:00Z" }, now, clock),
    ).toEqual(["last: searched the web, 40 min ago", "next: 07:00"]);
    expect(aboutLines({ agent: "planner", doing: "idle", what: "idle" }, now, clock)).toEqual([]);
  });

  it("fits each line on a tag, the time it did it in full", () => {
    const long = { what: "talking in #draft-review-for-the-newsletter", at: minutes(40) };
    const [line] = aboutLines({ agent: "planner", doing: "idle", what: "idle", last: long }, now, clock);
    expect(line.length).toBeLessThanOrEqual(TAG_LINE_CHARS);
    expect(line).toMatch(/^last: talked in #draft.*…, 40 min ago$/);
  });

  it("says nothing of it while the agent is busy", () => {
    expect(aboutLines({ agent: "planner", doing: "working", what: "searching the web", last }, now, clock)).toEqual([]);
  });

  it("says why an agent is asleep and until when", () => {
    const asleep = { agent: "planner", doing: "asleep" as const, what: "asleep", detail: "paused" };
    expect(asleepWords({ ...asleep, until: "2026-10-19T09:30:00Z" }, clock)).toBe("paused until 09:30");
    expect(asleepWords({ ...asleep, detail: "agents are paused" }, clock)).toBe("agents are paused");
  });
});
