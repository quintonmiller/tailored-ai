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
  launchError: undefined as string | undefined,
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: async () => {
      pw.launches++;
      if (pw.launchError) throw new Error(pw.launchError);
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

import { PlaceCamera, photoProblem } from "../plugins/places-camera.js";

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
  pw.launchError = undefined;
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

  it("says in a plain sentence that the browser isn't installed, not Playwright's banner", async () => {
    // What Playwright throws when the package is there but its browser was never downloaded.
    pw.launchError = [
      "browserType.launch: Executable doesn't exist at /home/test/.cache/ms-playwright/chromium_headless_shell-1179/chrome-linux/headless_shell",
      "╔═════════════════════════════════════════════════════════════════════════╗",
      "║ Looks like Playwright Test or Playwright was just installed or updated. ║",
      "║ Please run the following command to download new browsers:              ║",
      "║                                                                         ║",
      "║     npx playwright install                                              ║",
      "╚═════════════════════════════════════════════════════════════════════════╝",
    ].join("\n");
    const camera = new PlaceCamera(() => access);
    const said = await camera.take({ agent: "guide", view: "room" }).then(
      () => "",
      (err: Error) => err.message,
    );
    expect(said).toBe(
      "No photo: the browser photos are taken with isn't installed on this server. Someone running TAI can install it with `npx playwright install chromium`.",
    );
    // One sentence or two, no box drawing, nobody's home directory.
    expect(said).not.toMatch(/[\u2500-\u257f]|\/home\/|\n/);
    await camera.close();
  });
});

describe("why a photo couldn't be taken", () => {
  it("says what's missing and what a person can do, and keeps paths and call logs out of anything else", () => {
    expect(
      photoProblem(new Error("Host system is missing dependencies to run browsers. Run npx playwright install-deps")),
    ).toMatch(/system libraries it needs are missing.*npx playwright install-deps chromium/);
    expect(
      photoProblem(new Error("page.waitForSelector: Timeout 45000ms exceeded.\nCall log:\n  - waiting for locator")),
    ).toBe("No photo: the room took too long to draw. Try again in a moment.");
    expect(photoProblem(new Error("spawn /home/test/.cache/ms-playwright/x/chrome EACCES\nmore detail"))).toBe(
      "spawn … EACCES",
    );
    // Already plain: as it was.
    expect(photoProblem(new Error("The room couldn't be drawn: guide has no avatar."))).toBe(
      "The room couldn't be drawn: guide has no avatar.",
    );
    expect(photoProblem("")).toBe("No photo: something went wrong taking it.");
  });
});
