/**
 * Agents' days, as the world shows them: the places plugin sends a body with
 * nothing to do out on an errand (`places-routines.ts` in core) — a coffee at
 * the café, a bench in the park, a friend's — and to bed at night, writing it
 * on the body's `visit` record. Here is what that makes of an agent's
 * activity ("having a coffee at the café", asleep for the night), who keeps
 * whom company, when one chatting gestures, which buildings have someone in
 * them, what a meeting room's whiteboard says, and how long ago a room last
 * talked, for the plate on its door. Pure, so it is tested without a GPU.
 */
import { nameOf } from "../lib/conversations";
import { ago } from "../lib/tasks";
import { BASE_HUE, hexToHsl } from "./body";
import { type AgentActivity, hueFor } from "./doing";
import { buildingOf, type TownPlan } from "./town";

/** An outing, as the places plugin writes it on a body's `visit` record. A visit to talk has no `errand`. */
export interface Outing {
  place: string;
  until: string;
  spot?: string;
  errand?: string;
  with?: string[];
  what?: string;
}

/** What a body out is doing, as its activity carries it: where to sit, and whom it is with. */
export interface Routine {
  errand: string;
  /** The seat it is at, when it is here to sit at it. */
  spot?: string;
  /** Who it keeps company. */
  with?: string[];
}

/** An outing still going at `now`; nothing once it has run out, or for a visit to talk. */
export function outingNow(o: Partial<Outing> | undefined, now: number): Outing | undefined {
  if (!o || typeof o.errand !== "string" || !o.errand || typeof o.place !== "string") return undefined;
  const until = typeof o.until === "string" ? Date.parse(o.until) : Number.NaN;
  return Number.isFinite(until) && until > now ? (o as Outing) : undefined;
}

/** Names in a list, as said: "writer", "writer and planner", "writer, planner and coach". */
function names(agents: string[]): string {
  const all = agents.map(nameOf);
  return all.length > 1 ? `${all.slice(0, -1).join(", ")} and ${all.at(-1)}` : (all[0] ?? "");
}

/**
 * Every agent's activity as the world shows it, with the routines going on
 * at `now`. One idle and out is doing what its outing says, in its words;
 * one put to bed for the night is asleep, though nothing paused it, until it
 * gets up. One that is busy, waiting or paused is left as it is: work wins,
 * and the server ends its outing as it starts. Someone with company is
 * chatting with them, and a host at home with nothing on has whoever dropped
 * in round. The seat and the company are given only for bodies in `here`,
 * the place on the stage: the map and an agent's card read the words alone.
 * How long it has been idle is no longer how long it has been doing this, so
 * that goes.
 */
export function withRoutines(
  activities: Record<string, AgentActivity>,
  visits: Record<string, Partial<Outing>>,
  now: number,
  here?: string,
): Record<string, AgentActivity> {
  let out = activities;
  const set = (agent: string, a: AgentActivity) => {
    if (out === activities) out = { ...activities };
    out[agent] = a;
  };
  const hosting = new Map<string, string[]>();
  for (const [agent, record] of Object.entries(visits)) {
    const o = outingNow(record, now);
    if (!o) continue;
    const own = activities[agent];
    if (own && own.doing !== "idle") continue;
    const there = here === o.place;
    // Company that has gone (called away to work a moment ago) isn't kept, though the server only says so at its next
    // look: those still out in the same place, and a host in its own home.
    const company = (o.with ?? []).filter(
      (w) => outingNow(visits[w], now)?.place === o.place || (o.errand === "friend" && o.place === `home:${w}`),
    );
    const routine: Routine = {
      errand: o.errand as string,
      ...(there && o.spot ? { spot: o.spot } : {}),
      ...(there && company.length ? { with: company } : {}),
    };
    const { since: _, ...was } = own ?? { agent };
    // Put to bed: "asleep · overnight until 7:10" up close, short enough for a tag in any clock.
    if (o.errand === "sleep") {
      set(agent, { ...was, agent, doing: "asleep", what: "asleep", detail: "overnight", until: o.until, routine });
      continue;
    }
    // Dropping in on a friend, it is with its host already, by the words: only other guests are named.
    const others = o.errand === "friend" ? company.filter((w) => o.place !== `home:${w}`) : company;
    const along = others.length ? ` with ${names(others)}` : "";
    set(agent, { ...was, agent, doing: "idle", what: `${o.what ?? "out"}${along}`, routine });
    if (o.errand === "friend" && o.place.startsWith("home:")) {
      const host = o.place.slice("home:".length);
      hosting.set(host, [...(hosting.get(host) ?? []), agent]);
    }
  }
  for (const [host, guests] of hosting) {
    const own = activities[host];
    if ((own && own.doing !== "idle") || visits[host]?.errand) continue;
    const { since: _, ...was } = own ?? { agent: host };
    set(host, {
      ...was,
      agent: host,
      doing: "idle",
      what: `having ${names(guests)} round`,
      routine: { errand: "host", ...(here === `home:${host}` ? { with: guests } : {}) },
    });
  }
  return out;
}

/** Seconds between one chatting body's gestures: the same run for the same agent, a few seconds apart. */
export function chatPause(agent: string, n: number): number {
  let h = 2166136261;
  for (const c of `${agent}\n${n}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return 3.5 + ((h >>> 0) % 1000) / 200;
}

/** The gestures of a chat, in turn: talking with the hands, then nodding along, a laugh now and then. */
const CHAT_MOVES = ["chat", "nod", "chat", "chat", "nod", "laugh"];

/** A chatting body's `n`th gesture: two side by side never move in step, as each starts its run from its name. */
export function chatMove(agent: string, n: number): string {
  let h = 0;
  for (const c of agent) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CHAT_MOVES[(h + n) % CHAT_MOVES.length];
}

/**
 * A chatting body's gesture at `t`, when one is due (`c`, its count and when
 * the next is, moved on): none while a gesture of its own is still playing
 * (`own`, until when: one it chose, or one a person made from its card),
 * which puts the chat off until a little after.
 */
export function chatDue(
  c: { n: number; at: number },
  agent: string,
  t: number,
  own = Number.NEGATIVE_INFINITY,
): string | undefined {
  if (t < c.at) return undefined;
  if (t < own) {
    c.at = own + chatPause(agent, c.n);
    return undefined;
  }
  const move = chatMove(agent, c.n);
  c.n++;
  c.at = t + chatPause(agent, c.n);
  return move;
}

/**
 * The buildings with someone in them, by id: those the map has a body in,
 * a house or the town hall as much as the office (every meeting room in it)
 * or a shop on Main Street. Their windows light up.
 */
export function occupied(places: { id: string; agents: string[] }[], plan: TownPlan): Set<string> {
  const out = new Set<string>();
  for (const p of places) {
    const building = p.agents.length ? buildingOf(plan, p.id) : undefined;
    if (building) out.add(building.id);
  }
  return out;
}

/** A room's chatter, as the places plugin keeps it: how its latest lines began, and when it last talked. */
export interface Chatter {
  room: string;
  last: string;
  lines: { id: string; who: string; agent?: string; words: string; at: string }[];
}

/** What a meeting room's whiteboard says: its room, how long since it talked, and its last few lines, oldest first. */
export interface Notes {
  room: string;
  /** "talked 5 min ago", or nothing for a room never heard. */
  talked?: string;
  /** Each line: who said it, the agent behind the name, how it began, and the ink the name is written in. */
  lines: { who: string; agent?: string; words: string; ink: string }[];
}

/**
 * A meeting room's whiteboard, from its room's chatter; `chosen`, the colours
 * agents chose for their bodies; `last`, when the room last talked as its
 * door says (`talkedAt`), so the board and the door never disagree.
 */
export function notesFrom(
  chatter: Chatter | undefined,
  room: string,
  now: number,
  chosen: Readonly<Record<string, string>> = {},
  last: string | undefined = chatter?.last,
): Notes {
  const talked = talkedWords(last, now);
  return {
    room: chatter?.room ?? room,
    ...(talked ? { talked } : {}),
    lines: (chatter?.lines ?? []).map((l) => ({
      who: l.who,
      ...(l.agent ? { agent: l.agent } : {}),
      words: l.words,
      ink: inkFor(l.agent, l.agent ? chosen[l.agent] : undefined),
    })),
  };
}

/** How long since a room last talked, in a few words for its door and whiteboard: "talked 5 min ago". */
export function talkedWords(at: string | undefined, now: number): string | undefined {
  const when = ago(at, now);
  return when ? `talked ${when}` : undefined;
}

/**
 * When each room last talked, by its meeting room's id: what it said, as its
 * chatter has it, or else when the map last saw it wake someone. The later
 * of the two wins.
 */
export function talkedAt(
  chatter: Record<string, Partial<Chatter>>,
  places: { id: string; talked?: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const later = (id: string, at: string | undefined) => {
    if (!at || !Number.isFinite(Date.parse(at))) return;
    if (!out[id] || Date.parse(at) > Date.parse(out[id])) out[id] = at;
  };
  for (const p of places) later(p.id, p.talked);
  for (const [id, c] of Object.entries(chatter)) later(id, c.last);
  return out;
}

/**
 * The ink a name is written in on a whiteboard: the colour its body chose
 * (`chosen`, "#rrggbb"), or the one its name gives it, as the dot by its name
 * has it (`dotColor`), dark enough to read on white. A person's is plain.
 */
export function inkFor(agent: string | undefined, chosen?: string): string {
  const own = chosen ? hexToHsl(chosen) : undefined;
  // Its hue, as saturated as it chose up to a point (a grey body's name is grey), and dark.
  if (own) return `hsl(${Math.round(own[0])} ${Math.round(Math.min(70, own[1] * 100))}% 32%)`;
  const hue = agent ? hueFor(agent) : undefined;
  return hue === undefined ? "#3b4252" : `hsl(${(BASE_HUE + hue) % 360} 60% 32%)`;
}

/**
 * A meeting room's whiteboard, as the picture on the wall shows it from
 * across the room: the room's name, how long since it talked, and its last
 * few lines, each with who said it, in their colour. Live HTML takes over up
 * close (`Faces.tsx`). With no notes (in a photo, or a whiteboard an agent
 * put up somewhere else), it is a clean board.
 */
export function drawNotes(canvas: HTMLCanvasElement, notes: Notes | undefined) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, w, h);
  if (!notes) return;
  const pad = w * 0.045;
  ctx.textBaseline = "top";
  ctx.fillStyle = "#24427a";
  ctx.font = `700 ${Math.round(h * 0.085)}px system-ui, sans-serif`;
  ctx.fillText(`#${notes.room}`, pad, pad * 0.8, w * 0.6);
  if (notes.talked) {
    ctx.fillStyle = "#7a8294";
    ctx.font = `500 ${Math.round(h * 0.05)}px system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(notes.talked, w - pad, pad * 1.1);
    ctx.textAlign = "left";
  }
  const size = Math.round(h * 0.062);
  let y = pad * 0.8 + h * 0.15;
  if (!notes.lines.length) {
    ctx.fillStyle = "#a3aab8";
    ctx.font = `italic 400 ${size}px system-ui, sans-serif`;
    ctx.fillText("Nothing said here yet.", pad, y);
    return;
  }
  // Each line as the page lays it out up close: its words flow on from who said them, two rows at most.
  const width = w - 2 * pad;
  for (const line of notes.lines) {
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.fillStyle = line.ink;
    const who = `${line.agent ? nameOf(line.agent) : line.who}:`;
    ctx.fillText(who, pad, y, width);
    const indent = Math.min(width, ctx.measureText(who).width) + size * 0.3;
    ctx.font = `400 ${size}px system-ui, sans-serif`;
    ctx.fillStyle = "#1f2430";
    const rows = flowRows(line.words, indent, width, (s) => ctx.measureText(s).width);
    for (const [k, row] of rows.entries()) {
      const at = k ? 0 : indent;
      if (row) ctx.fillText(row, pad + at, y + k * size * 1.25, width - at);
    }
    y += Math.max(1, rows.length) * size * 1.25 + size * 0.45;
  }
}

/**
 * Words laid out in rows `width` wide, as a line of a whiteboard is: the
 * first row starts `indent` in, after who said it (or on the next row when a
 * long name leaves too little of it), and the last of at most `rows` ends in
 * an ellipsis when there is more. `measure` says how wide a piece of text is.
 */
export function flowRows(
  words: string,
  indent: number,
  width: number,
  measure: (text: string) => number,
  rows = 2,
): string[] {
  const out: string[] = [];
  // A name taking most of the first row: the words start on the next.
  if (width - indent < width * 0.3) out.push("");
  const room = () => (out.length ? width : width - indent);
  let row = "";
  const list = words.split(/\s+/).filter(Boolean);
  for (const word of list) {
    const next = row ? `${row} ${word}` : word;
    if (!row || measure(next) <= room()) {
      row = next;
      continue;
    }
    out.push(row);
    row = word;
    if (out.length === rows) {
      // Out of rows: the last is cut short to fit an ellipsis.
      let last = out[rows - 1];
      const fits = rows - 1 ? width : width - indent;
      while (last.includes(" ") && measure(`${last}…`) > fits) last = last.replace(/\s+\S+$/, "");
      out[rows - 1] = `${last.replace(/[\s,;:.!?-]+$/, "")}…`;
      return out;
    }
  }
  if (row && out.length < rows) out.push(row);
  return out;
}
