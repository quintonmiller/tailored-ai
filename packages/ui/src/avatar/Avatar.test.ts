/**
 * What the stage keeps speech bubbles out from under, and frames the agent
 * clear of: the controls laid over it, each by itself.
 */
import { describe, expect, it } from "vitest";
import { OVERLAYS } from "./Avatar";

describe("OVERLAYS", () => {
  it("names each tool over the stage and the view toggle, never the row the tools wrap in or its break", () => {
    const stage = document.createElement("div");
    stage.innerHTML = `
      <div class="talk-host"></div>
      <div class="talk-tools">
        <button class="talk-tool">Map</button>
        <button class="talk-tool">Tasks</button>
        <span class="talk-tools-break"></span>
        <nav class="world-trail">Main building › Residences</nav>
      </div>
      <fieldset class="talk-view"><button>Room</button></fieldset>
      <p class="talk-keys">WASD to walk</p>`;
    const named = [...stage.querySelectorAll(OVERLAYS)].map((e) => e.className);
    expect(named).toEqual(["talk-tool", "talk-tool", "world-trail", "talk-view"]);
  });
});
