/**
 * What an agent is for, read from its name, description, instructions and
 * tools: a word for it, the kind of home that suits it, and what it wears.
 * Words alone, no model: the name counts most, a tie goes to the more
 * particular role, and a stray word is not a role. What to wear comes from
 * words too, one thing to each place on the body.
 */
import { describe, expect, it } from "vitest";
import { homeFor, parseWear, ROLES, readRole, roleScores, WEAR, wearWords } from "../plugins/places-roles.js";
import { PRESETS, ROLE_DRESSINGS } from "../plugins/places-rooms.js";

const word = (name: string, more: { description?: string; instructions?: string; tools?: string[] } = {}) =>
  readRole({ name, ...more })?.word;

describe("reading what an agent is for", () => {
  it("reads it from a role-like name", () => {
    expect(word("coder")).toBe("coder");
    expect(word("podcast-producer")).toBe("producer");
    expect(word("bookkeeper")).toBe("bookkeeper");
    expect(word("game-master")).toBe("game master");
    expect(word("player-one")).toBe("player");
    expect(word("mail-sorter")).toBe("clerk");
    expect(word("room-keeper")).toBe("housekeeper");
    expect(word("scribe")).toBe("writer");
    expect(word("debugger")).toBe("coder");
    expect(word("healthCoach")).toBe("coach");
    expect(word("designer")).toBe("artist");
  });

  it("gives a tie to the more particular role", () => {
    // Travel and planning both say it; a trip planner is a travel agent first.
    expect(word("trip-planner")).toBe("travel agent");
    expect(word("code-reviewer")).toBe("reviewer");
  });

  it("reads a plain name from its description and instructions", () => {
    expect(word("sam", { description: "Keeps the household budget and pays the bills." })).toBe("bookkeeper");
    expect(word("juno", { instructions: "You write and edit the weekly newsletter. Keep drafts short." })).toBe(
      "writer",
    );
  });

  it("counts the name over the instructions", () => {
    const writer = {
      instructions: "You sometimes read code, and write code examples in the code blocks of your essays.",
    };
    expect(word("writer", writer)).toBe("writer");
    expect(roleScores({ name: "writer", ...writer }).get("coder")).toBeGreaterThan(0);
  });

  it("counts the tools an agent is given, but not having every tool", () => {
    expect(word("helper", { tools: ["exec", "edit", "read_file"] })).toBe("coder");
    expect(word("helper", { tools: ["speak"] })).toBe("producer");
    expect(word("helper")).toBeUndefined();
  });

  it("finds no role in a stray word, or in nothing at all", () => {
    expect(word("zork")).toBeUndefined();
    expect(word("", {})).toBeUndefined();
    expect(word("ada", { instructions: "Answer questions. Now and then, plan ahead." })).toBeUndefined();
  });

  it("gives every role homes that exist, work that a home can have, and things to wear that exist", () => {
    const presets = new Set(PRESETS.map((p) => p.id));
    for (const role of ROLES) {
      expect(role.homes.length, role.id).toBeGreaterThan(0);
      for (const home of role.homes) expect(presets.has(home), `${role.id}: ${home}`).toBe(true);
      if (role.dressing) expect(ROLE_DRESSINGS[role.dressing], role.id).toBeDefined();
      expect(role.wear.length, role.id).toBeGreaterThanOrEqual(1);
      expect(role.wear.length, role.id).toBeLessThanOrEqual(2);
      expect(parseWear(role.wear), role.id).toEqual({ wear: role.wear });
    }
  });

  it("dresses roles differently enough to tell apart across a hall", () => {
    const looks = new Set(ROLES.map((r) => r.wear.join("+")));
    expect(looks.size).toBe(ROLES.length);
  });
});

describe("the home that suits a role", () => {
  const coder = readRole({ name: "coder" });

  it("is one of the role's kinds of home, the same every time for the same agent", () => {
    const home = homeFor(coder, "home:coder");
    expect(coder?.homes).toContain(home.kind);
    expect(home.dressing).toBe("rack");
    expect(homeFor(coder, "home:coder")).toEqual(home);
  });

  it("is chosen by the seed among them, so two coders don't all live in the same kind of room", () => {
    const kinds = new Set(Array.from({ length: 20 }, (_, i) => homeFor(coder, `home:coder-${i}`).kind));
    expect(kinds).toEqual(new Set(coder?.homes));
  });

  it("is the seed's alone for an agent with no role", () => {
    expect(homeFor(undefined, "home:zork")).toEqual({});
  });
});

describe("what a body wears, in words", () => {
  it("reads a list in words, with articles, other names and plurals", () => {
    expect(parseWear("glasses, scarf")).toEqual({ wear: ["glasses", "scarf"] });
    expect(parseWear("a cap and a lanyard")).toEqual({ wear: ["cap", "lanyard"] });
    expect(parseWear("Headphones + bowtie")).toEqual({ wear: ["headset", "bow tie"] });
    expect(parseWear("the wizard-hat")).toEqual({ wear: ["wizard hat"] });
    expect(parseWear("a headset with mic")).toEqual({ wear: ["headset"] });
    expect(parseWear("satchels")).toEqual({ wear: ["satchel"] });
    expect(parseWear(["tool belt", "badge"])).toEqual({ wear: ["tool belt", "lanyard"] });
    expect(parseWear("glasses, glasses")).toEqual({ wear: ["glasses"] });
  });

  it("reads nothing at all, and going back to what suits the role", () => {
    expect(parseWear("none")).toEqual({ wear: [] });
    expect(parseWear([])).toEqual({ wear: [] });
    expect(parseWear("default")).toEqual({ suited: true });
  });

  it("says why when it can't: something unknown, two things in one place, too many", () => {
    const unknown = parseWear("a crown");
    expect("problem" in unknown && unknown.problem).toMatch(/"crown" isn't something a body can wear.*beret/);
    const clash = parseWear("cap, beret");
    expect("problem" in clash && clash.problem).toMatch(/a cap and a beret both go on the head/);
    const many = parseWear("headset, glasses, scarf, lanyard, satchel");
    expect("problem" in many && many.problem).toMatch(/at most 4/);
  });

  it("names every thing it knows in words", () => {
    expect(wearWords([])).toBe("nothing");
    expect(wearWords(["glasses"])).toBe("glasses");
    expect(wearWords(["adventurer hat", "satchel"])).toBe("an adventurer hat and a satchel");
    expect(wearWords(["headset", "glasses", "scarf"])).toBe("a headset, glasses and a scarf");
    for (const thing of Object.keys(WEAR)) expect(parseWear(thing)).toEqual({ wear: [thing] });
  });
});
