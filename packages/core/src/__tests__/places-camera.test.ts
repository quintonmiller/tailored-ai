/**
 * The places camera opens the UI in a headless browser with the server's own
 * read header. That header must reach the server and nothing else, and the
 * picture is of the frame the page says is ready.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pw = vi.hoisted(() => ({
  route: undefined as ((route: unknown) => unknown) | undefined,
  visited: [] as string[],
  attribute: "ready",
  launches: 0,
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: async () => {
      pw.launches++;
      return {
        newContext: async () => ({
          route: async (_pattern: string, handler: (route: unknown) => unknown) => {
            pw.route = handler;
          },
          newPage: async () => ({
            goto: async (url: string) => {
              pw.visited.push(url);
            },
            waitForSelector: async () => ({
              getAttribute: async () => pw.attribute,
              textContent: async () => "guide has no avatar.",
              screenshot: async () => Buffer.from("picture"),
            }),
          }),
          close: async () => {},
        }),
        close: async () => {},
      };
    },
  },
}));

import { PlaceCamera } from "../plugins/places-camera.js";

const access = { baseUrl: "http://127.0.0.1:3000", headers: { "x-tai-render": "secret" } };

function request(url: string) {
  const calls: { kind: string; headers?: Record<string, string> }[] = [];
  return {
    calls,
    route: {
      request: () => ({ url: () => url, headers: () => ({ accept: "*/*" }) }),
      abort: async () => calls.push({ kind: "abort" }),
      continue: async (opts: { headers: Record<string, string> }) =>
        calls.push({ kind: "continue", headers: opts.headers }),
    },
  };
}

beforeEach(() => {
  pw.route = undefined;
  pw.visited.length = 0;
  pw.attribute = "ready";
});

describe("the places camera", () => {
  it("opens the snapshot page for the shot and returns the ready frame", async () => {
    const camera = new PlaceCamera(() => access);
    const png = await camera.take({ agent: "guide", view: "selfie", spot: "couch", gesture: "wave" });
    expect(png.toString()).toBe("picture");
    expect(pw.visited).toEqual(["http://127.0.0.1:3000/#/snapshot?agent=guide&view=selfie&spot=couch&gesture=wave"]);
    await camera.close();
  });

  it("sends the server's header to the server, and refuses everything else", async () => {
    const camera = new PlaceCamera(() => access);
    await camera.take({ agent: "guide", view: "room" });
    const own = request("http://127.0.0.1:3000/api/live?agent=guide");
    await pw.route?.(own.route);
    expect(own.calls).toEqual([{ kind: "continue", headers: { accept: "*/*", "x-tai-render": "secret" } }]);
    for (const elsewhere of ["https://fonts.example.com/a.woff2", "http://127.0.0.1:8080/v1/models"]) {
      const other = request(elsewhere);
      await pw.route?.(other.route);
      expect(other.calls).toEqual([{ kind: "abort" }]);
    }
    await camera.close();
  });

  it("says why when the page couldn't draw the room, or there's no server to ask", async () => {
    pw.attribute = "failed";
    const camera = new PlaceCamera(() => access);
    await expect(camera.take({ agent: "guide", view: "room" })).rejects.toThrow(/guide has no avatar/);
    await camera.close();
    await expect(new PlaceCamera(() => undefined).take({ agent: "guide", view: "room" })).rejects.toThrow(/TAI server/);
  });
});
