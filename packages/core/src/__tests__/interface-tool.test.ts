/**
 * The `interface` tool: what an agent can do, and what it is told.
 *
 * The component has to come back in the tool result as a part, since that is
 * how it reaches the web UI and every surface after it. And an agent can only
 * change what it sent itself.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import type { ToolOutput } from "../content/types.js";
import { InterfaceStore } from "../interfaces/store.js";
import "../tools/builtin.js";
import type { ToolContext } from "../tools/interface.js";
import { InterfaceTool } from "../tools/interface-tool.js";
import { toolFactoryRegistry } from "../tools/tool-factories.js";

let store: InterfaceStore;
let tool: InterfaceTool;
const ctx = (agentName = "planner"): ToolContext => ({ sessionId: "s1", workingDirectory: "/tmp", env: {}, agentName });

beforeEach(() => {
  store = new InterfaceStore(new Database(":memory:"));
  tool = new InterfaceTool(() => store);
});

async function sendChoice() {
  const res = await tool.execute(
    { action: "send", kind: "choice", props: { question: "Ship it?", options: ["yes", "no"] } },
    ctx(),
  );
  const output = res.output as ToolOutput;
  const id = (output.structured as { componentId: string }).componentId;
  return { res, output, id };
}

describe("interface tool", () => {
  it("sends a component as a part of its result, and records who sent it", async () => {
    const { res, output, id } = await sendChoice();
    expect(res.success).toBe(true);
    expect(output.parts[0]).toEqual({
      type: "text",
      text: `Sent choice ${id}. The answer will come back as the person's next message.`,
    });
    expect(output.parts[1]).toMatchObject({ type: "component", component: { id, kind: "choice" } });
    expect(store.get(id)).toMatchObject({ agent: "planner", sessionId: "s1", status: "open" });
  });

  it("accepts props sent as a JSON string", async () => {
    const res = await tool.execute(
      { action: "send", kind: "confirm", props: '{"summary": "Delete the draft?"}' },
      ctx(),
    );
    expect(res.success).toBe(true);
  });

  it("updates a component in place, keeping its id", async () => {
    const { id } = await sendChoice();
    const res = await tool.execute(
      { action: "update", id, props: { question: "Ship it now?", options: ["yes", "no", "later"] } },
      ctx(),
    );
    const output = res.output as ToolOutput;
    expect(output.parts[1]).toMatchObject({
      type: "component",
      component: { id, props: { question: "Ship it now?" } },
    });
    expect(store.get(id)?.spec.actions).toHaveLength(3);
  });

  it("will not let one agent change another's component, or change its kind", async () => {
    const { id } = await sendChoice();
    const other = await tool.execute({ action: "close", id }, ctx("reviewer"));
    expect(other.error).toBe(`${id} was sent by another agent; only it can change it.`);
    const rekind = await tool.execute({ action: "update", id, kind: "confirm", props: { summary: "x" } }, ctx());
    expect(rekind.error).toBe(`${id} is a choice; an update cannot change its kind. Send a new one instead.`);
  });

  it("closes a component, and says so when it was already closed", async () => {
    const { id } = await sendChoice();
    expect((await tool.execute({ action: "close", id, note: "decided" }, ctx())).output).toBe(
      `Closed choice ${id}; it no longer takes answers.`,
    );
    expect((await tool.execute({ action: "close", id }, ctx())).error).toBe(`choice ${id} is already closed.`);
    expect(store.get(id)?.note).toBe("decided");
  });

  it("hands back a bad request as a correction", async () => {
    const res = await tool.execute({ action: "send", kind: "choice", props: { question: "q", options: [] } }, ctx());
    expect(res.success).toBe(false);
    expect(res.error).toBe("The choice was not sent:\n- `options` must have at least 2 item(s)");
    expect((await tool.execute({ action: "send", props: {} }, ctx())).error).toBe(
      'send needs a `kind`: "choice", "form", "confirm" or "card".',
    );
  });

  it("is offered by default, and withheld when turned off", () => {
    const factory = toolFactoryRegistry.get("interface");
    const db = new Database(":memory:");
    const config = (enabled: boolean) => ({ tools: { interface: { enabled } } }) as unknown as AgentConfig;
    expect(factory?.(config(true), { db }).map((t) => t.name)).toEqual(["interface"]);
    expect(factory?.(config(false), { db })).toEqual([]);
  });
});
