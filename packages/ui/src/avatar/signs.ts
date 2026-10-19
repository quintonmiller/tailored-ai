/**
 * What floats over a body: a tag with its name and what it is doing, and a
 * sign for its state — thinking dots, a speech bubble, an exclamation when it
 * is waiting on you, a question when it is stuck, and Zs while it sleeps.
 * Drawn on canvases into sprites, so they always face the camera and stay
 * readable from any angle. Each stands on the top of the head; how big it is
 * drawn and how far up it goes are the screen's to say (`overhead.ts`).
 */
import * as THREE from "three";
import { TAG_LINE_CHARS } from "../lib/did";
import { doingCss, type Sign } from "./doing";
import { drawnScale } from "./overhead";

/** A sprite's canvas, in its pixels, and the metres each of them covers as made. */
interface Drawn {
  w: number;
  h: number;
  made: number;
}

function sprite(canvas: HTMLCanvasElement, height: number): THREE.Sprite {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  s.scale.set((height * canvas.width) / canvas.height, height, 1);
  // Standing on the point it is put at, so lifting it is the screen's up, whatever the camera's angle.
  s.center.set(0.5, 0);
  s.renderOrder = 10;
  const drawn: Drawn = { w: canvas.width, h: canvas.height, made: height / canvas.height };
  s.userData.drawn = drawn;
  return s;
}

/**
 * Size a sprite for the screen: `perPixel` metres a screen pixel where it
 * stands, and `limits` the screen pixels each of its canvas's may come out
 * at. Returns its size on the screen, in pixels.
 */
export function fitSprite(s: THREE.Sprite, perPixel: number, limits: [number, number]): [number, number] {
  const { w, h, made } = s.userData.drawn as Drawn;
  const k = drawnScale(made, perPixel, limits);
  s.scale.set(w * k, h * k, 1);
  return [(w * k) / perPixel, (h * k) / perPixel];
}

/**
 * Stand a sprite `lift` screen pixels up from where it is put, and `across`
 * pixels to the right of it, at the size it was last fitted to.
 */
export function liftSprite(s: THREE.Sprite, lift: number, perPixel: number, across = 0) {
  s.center.set(0.5 - across / Math.max(1e-6, s.scale.x / perPixel), -lift / Math.max(1e-6, s.scale.y / perPixel));
}

function disposeSprite(s: THREE.Sprite) {
  s.material.map?.dispose();
  s.material.dispose();
  s.removeFromParent();
}

/** At most this many characters on a line, so a long status doesn't stretch across the room. */
const LINE_CHARS = 34;

function clip(text: string, chars = LINE_CHARS): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

/** The smaller lines under a tag fit a few more characters in the same width. */
const MORE_CHARS = TAG_LINE_CHARS;

/**
 * A tag over the head: a name, a status, or both — the name on top, what it
 * is doing beneath in a lighter face — and any lines `more` adds below, in a
 * smaller one: what it did last, when it wakes.
 */
export function tag(lines: { name?: string; status?: string; more?: string[] }): THREE.Sprite | undefined {
  const rows = [
    ...(lines.name ? [{ text: clip(lines.name), font: "600 44px system-ui, sans-serif", color: "#f2f4fa" }] : []),
    ...(lines.status ? [{ text: clip(lines.status), font: "400 36px system-ui, sans-serif", color: "#cfd6ea" }] : []),
    ...(lines.more ?? []).map((text) => ({
      text: clip(text, MORE_CHARS),
      font: "400 33px system-ui, sans-serif",
      color: "#aeb8d4",
    })),
  ];
  if (!rows.length) return undefined;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const lineHeight = (font: string) => (font.includes("44px") ? 54 : font.includes("36px") ? 46 : 42);
  let width = 0;
  for (const r of rows) {
    if (ctx) ctx.font = r.font;
    width = Math.max(width, ctx?.measureText(r.text).width ?? r.text.length * 22);
  }
  canvas.width = Math.ceil(width + 52);
  canvas.height = rows.reduce((h, r) => h + lineHeight(r.font), 18);
  if (ctx) {
    ctx.fillStyle = "rgba(20, 22, 32, 0.74)";
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 34);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let y = 9;
    for (const r of rows) {
      const h = lineHeight(r.font);
      ctx.font = r.font;
      ctx.fillStyle = r.color;
      ctx.fillText(r.text, canvas.width / 2, y + h / 2 + 2);
      y += h;
    }
  }
  return sprite(canvas, 0.16 * (canvas.height / 72));
}

/** Lines of a bubble, and characters on each: a glimpse of what was said, not the transcript. */
const BUBBLE_LINES = 3;
const BUBBLE_CHARS = 30;

/** Words wrapped into at most a few short lines, the last cut short with an ellipsis when there is more. */
export function wrap(text: string, width = BUBBLE_CHARS, lines = BUBBLE_LINES): string[] {
  const out: string[] = [];
  let line = "";
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    if (word.length > width) word = `${word.slice(0, width - 1)}…`;
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) {
      line = next;
      continue;
    }
    out.push(line);
    line = word;
    if (out.length === lines) {
      // Out of room: the last line ends in an ellipsis.
      const last = out[lines - 1];
      out[lines - 1] = last.length >= width ? `${last.slice(0, width - 1)}…` : `${last}…`;
      return out;
    }
  }
  if (line) out.push(line);
  return out;
}

/** The white of a bubble, and of its tail. */
const BUBBLE_FILL = "rgba(252, 252, 255, 0.96)";

/**
 * A speech bubble with what was said in it, and the speaker's name over the
 * words when it has one: its tag is put away while it speaks, so the bubble
 * says who is talking. Its tail is drawn apart (`bubbleTail`), so it can
 * reach down to the speaker however far up the bubble has had to go.
 */
export function speechBubble(text: string, who?: string): THREE.Sprite {
  const lines = wrap(text);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = "500 38px system-ui, sans-serif";
  const nameFont = "700 30px system-ui, sans-serif";
  const name = who ? clip(who, BUBBLE_CHARS) : undefined;
  let width = 0;
  if (ctx) ctx.font = font;
  for (const l of lines) width = Math.max(width, ctx?.measureText(l).width ?? l.length * 20);
  if (ctx && name) ctx.font = nameFont;
  if (name) width = Math.max(width, ctx?.measureText(name).width ?? name.length * 17);
  const lineHeight = 48;
  const nameHeight = name ? 40 : 0;
  const pad = 26;
  canvas.width = Math.ceil(width + pad * 2);
  canvas.height = nameHeight + lines.length * lineHeight + pad * 2;
  if (ctx) {
    ctx.fillStyle = BUBBLE_FILL;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, 30);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (name) {
      ctx.font = nameFont;
      ctx.fillStyle = "#4a5470";
      ctx.fillText(name, canvas.width / 2, pad + nameHeight / 2 - 2);
    }
    ctx.font = font;
    ctx.fillStyle = "#1d2230";
    lines.forEach((l, i) => {
      ctx.fillText(l, canvas.width / 2, pad + nameHeight + lineHeight * i + lineHeight / 2 + 2);
    });
  }
  const bubble = sprite(canvas, 0.12 * (canvas.height / 72));
  // Over every tag and sign: what is being said is what to read.
  bubble.renderOrder = 12;
  return bubble;
}

/**
 * A bubble's tail: a narrow wedge, wide where it meets the bubble and coming
 * to a point at the speaker's head, stretched to whatever length the gap
 * between them is. Drawn under tags and bubbles, so one passing behind
 * another's never hides the words.
 */
export function bubbleTail(): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = BUBBLE_FILL;
    ctx.beginPath();
    ctx.moveTo(2, 0);
    ctx.lineTo(30, 0);
    ctx.lineTo(16, 64);
    ctx.closePath();
    ctx.fill();
  }
  const tail = sprite(canvas, 0.1);
  tail.renderOrder = 9;
  return tail;
}

function drawSign(sign: Sign): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const dots = (y: number, color: string) => {
    ctx.fillStyle = color;
    for (const x of [40, 64, 88]) {
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const disc = (color: string, mark: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1c1d22";
    ctx.font = "800 76px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(mark, 64, 70);
  };
  switch (sign) {
    case "think":
      // A thought cloud, with the small puffs that lead down to the head.
      ctx.fillStyle = "rgba(250, 250, 255, 0.95)";
      for (const [x, y, r] of [
        [44, 54, 26],
        [70, 44, 30],
        [92, 58, 24],
        [62, 66, 28],
        [24, 104, 7],
        [14, 120, 5],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      dots(56, "#4b5263");
      break;
    case "talk":
      ctx.fillStyle = "rgba(250, 250, 255, 0.95)";
      ctx.beginPath();
      ctx.roundRect(8, 18, 112, 72, 30);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(34, 86);
      ctx.lineTo(26, 114);
      ctx.lineTo(58, 88);
      ctx.fill();
      dots(54, "#3d7bd9");
      break;
    case "wait":
      disc(doingCss("waiting"), "!");
      break;
    case "stuck":
      disc(doingCss("stuck"), "?");
      break;
    case "sleep":
      ctx.fillStyle = "#cfe0ff";
      ctx.strokeStyle = "rgba(20, 22, 40, 0.6)";
      ctx.lineWidth = 6;
      ctx.textBaseline = "middle";
      for (const [text, size, x, y] of [
        ["z", 34, 26, 96],
        ["z", 46, 52, 66],
        ["Z", 60, 84, 32],
      ] as const) {
        ctx.font = `800 ${size}px system-ui, sans-serif`;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      }
      break;
  }
  return canvas;
}

/** A sign over a head, gently alive: it bobs, the Zs drift up and fade. */
export class SignPost {
  readonly group = new THREE.Group();
  private current: Sign | undefined;
  private shown: THREE.Sprite | undefined;
  private since = 0;
  /** Metres a screen pixel covers where it stands, as last laid out: its bob is in screen pixels, like the rest. */
  private perPixel = 0.005;

  /** Show a sign, or none. */
  set(sign: Sign | undefined, clock: number) {
    if (sign === this.current) return;
    this.current = sign;
    this.since = clock;
    if (this.shown) disposeSprite(this.shown);
    this.shown = sign ? sprite(drawSign(sign), sign === "sleep" ? 0.3 : 0.24) : undefined;
    if (this.shown) this.group.add(this.shown);
  }

  /** Size the sign for the screen; its height there in pixels, or undefined with no sign showing. */
  fit(perPixel: number, limits: [number, number]): number | undefined {
    this.perPixel = perPixel;
    return this.shown && this.group.visible ? fitSprite(this.shown, perPixel, limits)[1] : undefined;
  }

  /** Stand the sign `lift` screen pixels up from the top of the head. */
  place(lift: number) {
    if (this.shown) liftSprite(this.shown, lift, this.perPixel);
  }

  update(clock: number) {
    const s = this.shown;
    if (!s) return;
    const t = clock - this.since;
    const px = this.perPixel;
    if (this.current === "sleep") {
      const u = (t % 2.6) / 2.6;
      s.position.set(6 * u * px, 18 * u * px, 0);
      s.material.opacity = Math.min(1, 4 * u) * (1 - u * u);
    } else {
      s.position.set(0, 3 * Math.sin(t * 2.4) * px, 0);
      const pop = Math.min(1, t / 0.25);
      s.material.opacity = pop;
      if (this.current === "wait") s.position.y += 3 * Math.abs(Math.sin(t * 5)) * px;
    }
  }

  dispose() {
    if (this.shown) disposeSprite(this.shown);
    this.shown = undefined;
    this.group.removeFromParent();
  }
}

export { disposeSprite };
