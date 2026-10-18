/**
 * Components a turn produced, read back from the stored messages so a channel
 * that cannot draw them can still post their text form.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeMessageContent } from "../content/codec.js";
import type { ComponentSpec } from "../content/types.js";
import { initDatabase } from "../db/schema.js";
import { collectTurnComponents, withComponentText } from "../media/turn.js";

let db: ReturnType<typeof initDatabase>;

const spec = (id: string, question: string): ComponentSpec => ({
  id,
  kind: "choice",
  props: { question },
  fallback: `[choice ${id}] ${question}`,
});

function write(role: string, content: unknown): number {
  const encoded = typeof content === "string" ? content : encodeMessageContent(content as never);
  return Number(
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES ('s1', ?, ?)").run(role, encoded)
      .lastInsertRowid,
  );
}

const sent = (c: ComponentSpec) => ({
  parts: [
    { type: "text", text: `Sent ${c.kind} ${c.id}.` },
    { type: "component", component: c },
  ],
});

beforeEach(() => {
  db = initDatabase(":memory:");
  db.prepare("INSERT INTO sessions (id, key, model, provider) VALUES ('s1', 's1', 'm', 'p')").run();
});

afterEach(() => db.close());

describe("collectTurnComponents", () => {
  it("returns each component once, as its latest version, in the order first sent", () => {
    const start = write("user", "ask me two things");
    write("tool", sent(spec("c-1", "First?")));
    write("tool", sent(spec("c-2", "Second?")));
    write("tool", sent(spec("c-1", "First, revised?")));
    expect(collectTurnComponents(db, "s1", start).map((c) => [c.id, c.props.question])).toEqual([
      ["c-1", "First, revised?"],
      ["c-2", "Second?"],
    ]);
  });

  it("ignores what an earlier turn sent, and what was rewound", () => {
    write("tool", sent(spec("c-old", "Old?")));
    const start = write("user", "next turn");
    const rewound = write("tool", sent(spec("c-gone", "Gone?")));
    db.prepare("UPDATE messages SET rewound_batch = 1 WHERE id = ?").run(rewound);
    write("tool", sent(spec("c-new", "New?")));
    expect(collectTurnComponents(db, "s1", start).map((c) => c.id)).toEqual(["c-new"]);
  });
});

describe("withComponentText", () => {
  it("appends each component's text form below the reply", () => {
    expect(withComponentText("Two questions:", [spec("c-1", "A?"), spec("c-2", "B?")])).toBe(
      "Two questions:\n\n[choice c-1] A?\n\n[choice c-2] B?",
    );
    expect(withComponentText("", [spec("c-1", "A?")])).toBe("[choice c-1] A?");
    expect(withComponentText("Just words.", [])).toBe("Just words.");
  });
});
