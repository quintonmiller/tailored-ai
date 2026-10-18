/**
 * The web renderers for agent components: that each kind draws, that an
 * answer goes to the server and its reply into the chat, and that a component
 * the server says is finished is drawn finished.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentSpec } from "../lib/content.js";

const send = vi.fn();
vi.mock("./ChatContext", () => ({ useChatStore: () => ({ send }) }));

import { InterfaceComponents } from "./InterfaceComponents";

// React's act() needs to be told it is running under a test harness.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reply = { kind: "reply" as const };
const choice: ComponentSpec = {
  id: "c-1",
  kind: "choice",
  props: { question: "Which day?", options: ["Monday", "Tuesday"] },
  actions: [
    { id: "option-1", label: "Monday", effect: reply },
    { id: "option-2", label: "Tuesday", effect: reply },
  ],
  fallback: "[choice c-1] Which day?",
};

let root: Root;
let container: HTMLDivElement;
let serverState: Record<string, unknown>[] = [];
let respondResult: Record<string, unknown> = { effect: "reply", reply: "Monday" };
let respondStatus = 200;
const posted: { url: string; body: unknown }[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  serverState = [];
  respondResult = { effect: "reply", reply: "Monday" };
  respondStatus = 200;
  posted.length = 0;
  send.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(respondResult), { status: respondStatus });
      }
      return new Response(JSON.stringify({ components: serverState }), { status: 200 });
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(specs: ComponentSpec[]) {
  await act(async () => {
    root.render(<InterfaceComponents specs={specs} />);
  });
}

const buttons = () => [...container.querySelectorAll("button")];
const button = (text: string) => buttons().find((b) => b.textContent === text) as HTMLButtonElement;

describe("InterfaceComponents", () => {
  it("draws a choice, sends the answer, and puts the reply in the chat", async () => {
    await render([choice]);
    expect(container.textContent).toContain("Which day?");
    expect(buttons().map((b) => b.textContent)).toEqual(["Monday", "Tuesday"]);

    await act(async () => {
      button("Monday").click();
    });

    expect(posted).toEqual([{ url: "/api/interfaces/c-1/respond", body: { actionId: "option-1" } }]);
    expect(send).toHaveBeenCalledWith("Monday");
    expect(container.textContent).toContain("You answered: Monday");
    expect(button("Tuesday").disabled).toBe(true);
  });

  it("does not send an event action's answer into the chat", async () => {
    respondResult = { effect: "event" };
    await render([
      {
        id: "d-1",
        kind: "card",
        props: { title: "Disk full", fields: [{ label: "Used", value: "95%" }] },
        actions: [{ id: "a1", label: "Page me", effect: { kind: "event", name: "escalate" } }],
        fallback: "[card d-1] Disk full",
      },
    ]);
    expect(container.querySelector("dt")?.textContent).toBe("Used");
    expect(container.querySelector("dd")?.textContent).toBe("95%");
    await act(async () => {
      button("Page me").click();
    });
    expect(send).not.toHaveBeenCalled();
    expect(container.textContent).toContain("You answered: Page me");
  });

  it("draws a component the server says was answered as finished, with the answer", async () => {
    serverState = [
      {
        id: "c-1",
        kind: "choice",
        status: "answered",
        spec: choice,
        response: { actionId: "option-2", by: "owner", at: "" },
      },
    ];
    await render([choice]);
    expect(container.textContent).toContain("You answered: Tuesday");
    expect(buttons().every((b) => b.disabled)).toBe(true);
  });

  it("shows the server's refusal instead of pretending it worked", async () => {
    respondStatus = 409;
    respondResult = { error: "This question has expired." };
    await render([choice]);
    await act(async () => {
      button("Monday").click();
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("This question has expired.");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a form's send button off until required fields are filled", async () => {
    await render([
      {
        id: "f-1",
        kind: "form",
        props: { title: "Booking", fields: [{ name: "guests", label: "Guests", type: "number", required: true }] },
        actions: [{ id: "submit", label: "Book", effect: reply }],
        fallback: "[form f-1] Booking",
      },
    ]);
    expect(container.querySelector("label")?.textContent).toBe("Guests *");
    expect(button("Book").disabled).toBe(true);
  });

  it("falls back to the text form for a kind it cannot draw", async () => {
    await render([{ id: "r-1", kind: "rating", props: {}, fallback: "[rating r-1] Rate the hotel from 1 to 5." }]);
    expect(container.textContent).toContain("Rate the hotel from 1 to 5.");
  });
});

describe("bound cards and state buttons", () => {
  class FakeEventSource {
    static last: FakeEventSource | undefined;
    listeners = new Map<string, ((ev: { data: string }) => void)[]>();
    constructor(readonly url: string) {
      FakeEventSource.last = this;
    }
    addEventListener(event: string, fn: (ev: { data: string }) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    }
    emit(event: string, data: unknown) {
      for (const fn of this.listeners.get(event) ?? []) fn({ data: JSON.stringify(data) });
    }
    close() {}
  }

  const bound: ComponentSpec = {
    id: "c-9",
    kind: "card",
    props: { title: "Lisbon trip", fields: [{ label: "status", value: "draft" }] },
    actions: [
      {
        id: "a1",
        label: "Start",
        effect: { kind: "state", ref: { type: "plan", id: "trip" }, patch: { status: "active" } },
      },
    ],
    bind: { type: "plan", id: "trip" },
    fallback: "[card c-9] Lisbon trip",
  };
  const record = (status: string, version: number) => ({
    type: "plan",
    id: "trip",
    scope: "global",
    data: { name: "Lisbon trip", status },
    version,
    createdAt: "",
    updatedAt: "",
    updatedBy: { kind: "user", name: "owner" },
  });

  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted.push({ url, body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify({ effect: "state", record: record("active", 2) }));
        }
        if (url === "/api/state/types")
          return new Response(JSON.stringify({ types: [{ name: "plan", title: "name", canWrite: true }] }));
        if (url === "/api/state/plan/trip") return new Response(JSON.stringify(record("draft", 1)));
        return new Response(JSON.stringify({ components: [{ id: "c-9", kind: "card", status: "open", spec: bound }] }));
      }),
    );
  });

  const fields = () =>
    [...container.querySelectorAll(".iface-card-field")].map(
      (f) => `${f.querySelector("dt")?.textContent}=${f.querySelector("dd")?.textContent}`,
    );

  it("shows the record as it is now, and follows it as it changes", async () => {
    await render([bound]);
    await act(async () => {});
    expect(fields()).toEqual(["status=draft"]);
    expect(FakeEventSource.last?.url).toBe("/api/state/events");

    await act(async () =>
      FakeEventSource.last?.emit("change", {
        type: "plan",
        id: "trip",
        op: "update",
        version: 3,
        after: { name: "Lisbon trip", status: "done" },
      }),
    );
    expect(fields()).toEqual(["status=done"]);

    await act(async () => FakeEventSource.last?.emit("change", { type: "plan", id: "trip", op: "delete", version: 4 }));
    expect(container.textContent).toContain("This record was deleted.");
  });

  it("writes on click without sending anything to the chat, and stays clickable", async () => {
    await render([bound]);
    await act(async () => {});
    await act(async () => {
      button("Start").click();
    });

    expect(posted).toEqual([{ url: "/api/interfaces/c-9/respond", body: { actionId: "a1" } }]);
    expect(send).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Done: Start");
    expect(fields()).toEqual(["status=active"]);
    expect(button("Start").disabled).toBe(false);
  });
});
