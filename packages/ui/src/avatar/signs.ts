/**
 * What floats over a body: a tag with its name and what it is doing, and a
 * sign for its state — thinking dots, a speech bubble, a phone while it talks
 * to someone somewhere else, an exclamation when it is waiting on you, a
 * question when it is stuck, Zs while it sleeps, and two small bubbles while
 * it keeps someone company out.
 * Drawn on canvases into sprites, so they always face the camera and stay
 * readable from any angle. Each stands on the top of the head; how big it is
 * drawn and how far up it goes are the screen's to say (`overhead.ts`).
 */
import * as THREE from "three";
import { TAG_LINE_CHARS } from "../lib/did";
import { doingCss, type Sign } from "./doing";
import { drawnScale } from "./overhead";
import { BUBBLE_CHARS, wrap } from "./wrap";

export { wrap };

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

/** The blue a phone is drawn in, on a sign, a bubble or a tag: the talking colour. */
const PHONE_BLUE = "#3d7bd9";
/** The dots of a chat between two out together: warm, so it isn't taken for a talk about work. */
const CHAT_DOTS = "#b0703c";

/**
 * A telephone handset, `size` pixels square with its top left at `x`, `y`:
 * the earpiece up at the left, the mouthpiece down at the right, the grip
 * curving between them.
 */
function drawHandset(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(5, 3);
  ctx.lineTo(8.5, 3);
  ctx.lineTo(10.1, 7.4);
  ctx.lineTo(7.8, 9.1);
  ctx.quadraticCurveTo(10, 13.9, 14.9, 16.2);
  ctx.lineTo(16.6, 13.9);
  ctx.lineTo(21, 15.5);
  ctx.lineTo(21, 19);
  ctx.quadraticCurveTo(21, 21, 19, 21);
  ctx.quadraticCurveTo(3, 21, 3, 5);
  ctx.quadraticCurveTo(3, 3, 5, 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** At most this many characters on a line, so a long status doesn't stretch across the room. */
const LINE_CHARS = 34;

function clip(text: string, chars = LINE_CHARS): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

/** The smaller lines under a tag fit a few more characters in the same width. */
const MORE_CHARS = TAG_LINE_CHARS;

/** A handset drawn before a line of a tag: its size, and the gap after it. */
const TAG_PHONE = 30;
const TAG_PHONE_GAP = 10;

/**
 * A tag over the head: a name, a status, or both — the name on top, what it
 * is doing beneath in a lighter face — and any lines `more` adds below, in a
 * smaller one: what it did last, when it wakes. On the phone, a handset
 * stands before the status.
 */
export function tag(lines: {
  name?: string;
  status?: string;
  more?: string[];
  phone?: boolean;
}): THREE.Sprite | undefined {
  const rows = [
    ...(lines.name ? [{ text: clip(lines.name), font: "600 44px system-ui, sans-serif", color: "#f2f4fa" }] : []),
    ...(lines.status
      ? [{ text: clip(lines.status), font: "400 36px system-ui, sans-serif", color: "#cfd6ea", phone: !!lines.phone }]
      : []),
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
  const mark = (r: { phone?: boolean }) => (r.phone ? TAG_PHONE + TAG_PHONE_GAP : 0);
  let width = 0;
  for (const r of rows) {
    if (ctx) ctx.font = r.font;
    width = Math.max(width, (ctx?.measureText(r.text).width ?? r.text.length * 22) + mark(r));
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
      // The handset and the words are centred together, the handset first.
      const shift = mark(r) / 2;
      if (shift) {
        const left = (canvas.width - ctx.measureText(r.text).width) / 2 - shift;
        drawHandset(ctx, left, y + (h - TAG_PHONE) / 2 + 1, TAG_PHONE, "#8fb8ff");
      }
      ctx.fillText(r.text, canvas.width / 2 + shift, y + h / 2 + 2);
      y += h;
    }
  }
  return sprite(canvas, 0.16 * (canvas.height / 72));
}

/** The white of a bubble, and of its tail. */
const BUBBLE_FILL = "rgba(252, 252, 255, 0.96)";
/** A bubble for the far side of a call, heard out of a phone here: a cooler white, edged in dashes. */
const FAR_FILL = "rgba(236, 242, 255, 0.96)";

/** A handset drawn in a bubble's top line: its size, and the gap after it. */
const BUBBLE_PHONE = 30;
const BUBBLE_PHONE_GAP = 8;

/**
 * A speech bubble with what was said in it, and the speaker's name over the
 * words when it has one: its tag is put away while it speaks, so the bubble
 * says who is talking. Its tail is drawn apart (`bubbleTail`), so it can
 * reach down to the speaker however far up the bubble has had to go. Said
 * down the phone, a handset stands before the name; heard out of a phone
 * here, from someone somewhere else (`far`), the bubble is edged in dashes.
 */
export function speechBubble(text: string, who?: string, how: { phone?: boolean; far?: boolean } = {}): THREE.Sprite {
  const lines = wrap(text);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = "500 38px system-ui, sans-serif";
  const nameFont = "700 30px system-ui, sans-serif";
  const name = who ? clip(who, BUBBLE_CHARS) : undefined;
  const phone = !!how.phone || !!how.far;
  const mark = phone ? BUBBLE_PHONE + (name ? BUBBLE_PHONE_GAP : 0) : 0;
  let width = 0;
  if (ctx) ctx.font = font;
  for (const l of lines) width = Math.max(width, ctx?.measureText(l).width ?? l.length * 20);
  if (ctx && name) ctx.font = nameFont;
  const nameWidth = name ? (ctx?.measureText(name).width ?? name.length * 17) : 0;
  width = Math.max(width, nameWidth + mark);
  const lineHeight = 48;
  const nameHeight = name || phone ? 40 : 0;
  const pad = 26;
  canvas.width = Math.ceil(width + pad * 2);
  canvas.height = nameHeight + lines.length * lineHeight + pad * 2;
  if (ctx) {
    ctx.fillStyle = how.far ? FAR_FILL : BUBBLE_FILL;
    ctx.beginPath();
    ctx.roundRect(
      how.far ? 3 : 0,
      how.far ? 3 : 0,
      canvas.width - (how.far ? 6 : 0),
      canvas.height - (how.far ? 6 : 0),
      30,
    );
    ctx.fill();
    if (how.far) {
      ctx.strokeStyle = PHONE_BLUE;
      ctx.lineWidth = 5;
      ctx.setLineDash([14, 10]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // The handset and the name are centred together on the top line, the handset first.
    const left = (canvas.width - nameWidth - mark) / 2;
    if (phone) drawHandset(ctx, left, pad + (nameHeight - BUBBLE_PHONE) / 2 - 2, BUBBLE_PHONE, PHONE_BLUE);
    if (name) {
      ctx.font = nameFont;
      ctx.fillStyle = "#4a5470";
      ctx.fillText(name, canvas.width / 2 + mark / 2, pad + nameHeight / 2 - 2);
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
 * between them is, and turned to point at its speaker wherever the bubble
 * went. Drawn under every tag (`Figure.placeOver`): led round them where it
 * can be, and passing behind a neighbour's name where it can't.
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

/** How wide the line from a tag that made way down to its head is, in CSS pixels. */
export const LEADER_WIDTH_PX = 2;

/**
 * The line from a tag that had to go off its head to make way for another,
 * down to the top of that head, so it is plain whose tag it is: thin, in the
 * tags' own white, stretched and turned to wherever the tag went
 * (`Figure.placeLeader`). Drawn under every tag, so it never crosses a name.
 */
export function leaderLine(): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 16;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "rgba(232, 236, 248, 0.9)";
    ctx.fillRect(1, 0, 2, 16);
  }
  const line = sprite(canvas, 0.1);
  line.renderOrder = 9.5;
  return line;
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
    case "phone":
      ctx.fillStyle = "rgba(250, 250, 255, 0.95)";
      ctx.beginPath();
      ctx.roundRect(8, 18, 112, 72, 30);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(34, 86);
      ctx.lineTo(26, 114);
      ctx.lineTo(58, 88);
      ctx.fill();
      // Face to face, the dots of talk; to someone somewhere else, a handset.
      if (sign === "phone") drawHandset(ctx, 40, 30, 48, PHONE_BLUE);
      else dots(54, PHONE_BLUE);
      break;
    case "wait":
      disc(doingCss("waiting"), "!");
      break;
    case "stuck":
      disc(doingCss("stuck"), "?");
      break;
    case "chat": {
      // Two small bubbles, one behind the other, each with its dots: two keeping each other company, in no words.
      const bubble = (x: number, y: number, w: number, h: number, fill: string, dot: string, tail: number) => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, h / 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x + tail, y + h - 4);
        ctx.lineTo(x + tail - 6, y + h + 16);
        ctx.lineTo(x + tail + 16, y + h - 2);
        ctx.fill();
        ctx.fillStyle = dot;
        for (const k of [0.3, 0.5, 0.7]) {
          ctx.beginPath();
          ctx.arc(x + w * k, y + h / 2, h * 0.1, 0, Math.PI * 2);
          ctx.fill();
        }
      };
      bubble(46, 14, 74, 46, "rgba(255, 236, 214, 0.95)", CHAT_DOTS, 50);
      bubble(8, 50, 74, 46, "rgba(250, 250, 255, 0.97)", CHAT_DOTS, 22);
      break;
    }
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

  /** Stand it `lift` screen pixels up from the top of the head, and `across` to the right, over its tag. */
  place(lift: number, across = 0) {
    if (this.shown) liftSprite(this.shown, lift, this.perPixel, across);
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
