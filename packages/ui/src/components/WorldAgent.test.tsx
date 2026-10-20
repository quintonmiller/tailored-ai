/**
 * An agent's card in the 3D world: what it is doing now, in the words the
 * world shows it in, out on its day as much as at work.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentActivity } from "../avatar/doing";
import { withRoutines } from "../avatar/routines";
import { WorldAgent } from "./WorldAgent";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = Date.parse("2026-10-20T12:30:00Z");

describe("an agent's card", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const card = (activity: AgentActivity | undefined) => {
    act(() =>
      root.render(
        <WorldAgent
          agent="writer"
          activity={activity}
          said={undefined}
          roomName={() => undefined}
          where={{ id: "town", name: "the town", home: false }}
          openTasks={0}
          online={false}
          talking={false}
          tasksWake={undefined}
          onChat={() => {}}
          onTasks={() => {}}
          onClose={() => {}}
        />,
      ),
    );
    return host.querySelector(".world-agent-doing")?.textContent ?? "";
  };

  it("says where it is out on its day, though it has nothing to do, and once to bed, until when", () => {
    const idle: AgentActivity = { agent: "writer", doing: "idle", what: "idle", since: "2026-10-20T08:00:00Z" };
    const out = withRoutines(
      { writer: idle },
      {
        writer: {
          place: "town",
          until: "2026-10-20T13:00:00Z",
          spot: "cafe-1-a",
          errand: "cafe",
          what: "having a coffee at the café",
        },
      },
      now,
    ).writer;
    expect(card(out)).toBe("having a coffee at the café");
    const asleep = withRoutines(
      { writer: idle },
      { writer: { place: "home:writer", until: "2026-10-20T13:00:00Z", spot: "bed", errand: "sleep" } },
      now,
    ).writer;
    expect(card(asleep)).toMatch(/^asleep · overnight until \d/);
    expect(card(idle)).toMatch(/^Idle for /);
  });
});
