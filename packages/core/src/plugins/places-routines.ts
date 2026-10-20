/**
 * Routines: what an agent's body does with its day while the agent has
 * nothing to do, so the square, the park and the meeting rooms have people in
 * them and not only the homes.
 *
 * Each agent has a day of its own, drawn from its name and the date and
 * shaped by what it is for (its role, `places-roles.ts`) and by its real
 * schedule: it is up before the hours it keeps when it runs on its own
 * (`online.cadence.window`) and in bed after them, and home in good time for
 * the next wake it booked. Between getting up and going to bed it spends
 * stretches at home and stretches out: a coffee at the café on the square, a
 * bench on the square or by the pond, reading in a shared place, sitting in
 * the meeting room of a room it belongs to while that room is lively, or
 * dropping in on an agent it often messages or shares rooms with. Mornings
 * lean to coffee and evenings to the park. At night it sleeps at home.
 *
 * Two or more at one table, on one bench, round one meeting table or in one
 * home keep each other company (`with`), and the page shows them chatting:
 * facing each other, with a sign, never with words nobody said.
 *
 * No model is asked. Work always wins: a body is never moved while its agent
 * is busy, a turn starting ends an outing at once (the body goes home, or to
 * the meeting room it is called to), a visit to talk (`Presence` in
 * `places.ts`) is never written over, and a paused agent stays home asleep.
 * An outing is the same memory-backed `visit` record a talk makes, with the
 * errand on it, so every page sees the same bodies in the same places, and a
 * restart sends everyone home.
 *
 * How busy the town is, or off, is the places plugin's config:
 *
 * ```yaml
 * plugins:
 *   - module: builtin:places
 *     config:
 *       routines: quiet     # quiet, normal (the default), busy, or off
 * ```
 *
 * Everything here is pure, down to {@link decide}, which says where every
 * body should be from what `places.ts` reads; {@link Routines} only fetches
 * and writes, once a minute.
 */
import { seeded } from "./places-rooms.js";

/** Somewhere an agent goes when it has nothing to do. */
export type Errand = "cafe" | "bench" | "park" | "read" | "meeting" | "friend";
export const ERRANDS: Errand[] = ["cafe", "bench", "park", "read", "meeting", "friend"];

/** How busy the town is: the share of its waking day each agent spends out, and the most out at once. */
export type Density = "quiet" | "normal" | "busy";
export const DENSITY: Record<Density, { share: number; most: number }> = {
  quiet: { share: 0.15, most: 6 },
  normal: { share: 0.3, most: 12 },
  busy: { share: 0.5, most: 24 },
};

/**
 * The plugin config's `routines`, read: how busy the town is, null when it is
 * off, or why it can't be read, in words for the log. Nothing said is
 * `normal`: routines are on unless turned off.
 */
export function parseRoutines(raw: unknown): Density | null | { problem: string } {
  if (raw === undefined || raw === null || raw === true) return "normal";
  if (raw === false || raw === "off") return null;
  if (typeof raw === "string" && raw in DENSITY) return raw as Density;
  return { problem: `routines is quiet, normal, busy or off, not ${JSON.stringify(raw)}.` };
}

// --------------------------------------------------------------------------
// The day
// --------------------------------------------------------------------------

/** When an agent gets up and goes to bed, in minutes from its day's midnight; bed may be past the next. */
export interface Hours {
  wake: number;
  sleep: number;
}

/** Roles up early, and those up late (see `places-roles.ts`). */
const EARLY = new Set(["housekeeper", "bookkeeper", "clerk", "coach", "concierge"]);
const LATE = new Set(["coder", "ops", "game-master", "player", "artist", "producer"]);

/** "HH:MM" as minutes from midnight; undefined for anything else. */
export function minuteOf(clock: string | undefined): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock?.trim() ?? "");
  if (!m) return undefined;
  const [h, min] = [Number(m[1]), Number(m[2])];
  return h < 24 && min < 60 ? h * 60 + min : undefined;
}

/**
 * When an agent gets up and goes to bed: between half six and half eight,
 * and ten and half eleven, by its name, earlier or later for its role. One
 * that keeps hours of its own (`window`, as `online.cadence.window` has them)
 * is up half an hour before they start and in bed an hour after they end.
 * Always up between fourteen and twenty hours, and never before four.
 */
export function hoursOf(agent: string, role?: string, window?: { start: string; end: string }): Hours {
  const rand = seeded(`hours\n${agent}`);
  const shift = role && EARLY.has(role) ? -40 : role && LATE.has(role) ? 50 : 0;
  let wake = 390 + Math.round(rand() * 120) + shift;
  let sleep = 1320 + Math.round(rand() * 90) + shift;
  const opens = minuteOf(window?.start);
  const closes = minuteOf(window?.end);
  if (opens !== undefined && closes !== undefined && opens !== closes) {
    wake = Math.min(wake, opens - 30);
    sleep = Math.max(sleep, (closes > opens ? closes : closes + 1440) + 60);
  }
  wake = Math.max(240, wake);
  sleep = Math.min(wake + 1200, Math.max(wake + 840, sleep));
  return { wake, sleep };
}

/** A stretch of a day, in minutes from its midnight: at home, or out on an errand. */
export interface Stretch {
  from: number;
  to: number;
  errand?: Errand;
}

/** What a day is drawn from. */
export interface DayOf {
  agent: string;
  role?: string;
  hours: Hours;
  density: Density;
}

/** Errands a role leans to: twice as likely as for anyone else. */
const LEANS: Record<string, Errand[]> = {
  coder: ["cafe"],
  writer: ["cafe", "read"],
  reporter: ["cafe", "bench"],
  producer: ["cafe", "meeting"],
  researcher: ["read"],
  tutor: ["read", "park"],
  reviewer: ["read", "meeting"],
  bookkeeper: ["read"],
  artist: ["park", "bench"],
  coach: ["park", "friend"],
  housekeeper: ["park", "bench"],
  travel: ["park", "friend"],
  planner: ["meeting", "cafe"],
  ops: ["meeting", "cafe"],
  "game-master": ["meeting", "friend"],
  player: ["friend", "meeting"],
  builder: ["meeting", "bench"],
  clerk: ["bench", "read"],
  concierge: ["friend", "cafe"],
};

/** How likely each errand is, by the hour it falls at: coffee in the morning, the park in the evening. */
export function errandWeights(hour: number, role?: string): Record<Errand, number> {
  const w: Record<Errand, number> = { cafe: 3, bench: 2, park: 2, read: 1.5, meeting: 2, friend: 1.5 };
  const times = (k: Partial<Record<Errand, number>>) => {
    for (const [e, f] of Object.entries(k)) w[e as Errand] *= f;
  };
  if (hour < 11) times({ cafe: 2.5, park: 0.6, meeting: 0.8, friend: 0.5 });
  else if (hour < 14) times({ cafe: 1.5, bench: 1.5 });
  else if (hour < 18) times({ meeting: 1.5, read: 1.5, friend: 1.2 });
  else times({ park: 2, friend: 1.6, cafe: 0.6, meeting: 0.6, read: 0.8 });
  for (const e of LEANS[role ?? ""] ?? []) w[e] *= 2;
  return w;
}

function pickWeighted(weights: Record<Errand, number>, r: number): Errand {
  const total = ERRANDS.reduce((n, e) => n + weights[e], 0);
  let left = r * total;
  for (const e of ERRANDS) {
    left -= weights[e];
    if (left < 0) return e;
  }
  return ERRANDS[ERRANDS.length - 1];
}

/**
 * An agent's waking day, from getting up to going to bed, as stretches at
 * home and out. It starts at home for up to an hour and a half, ends at home
 * for at least the last forty minutes, and in between an outing of half an
 * hour to eighty minutes comes after each spell at home, the spells long
 * enough that about the density's share of the day is spent out. The same
 * agent on the same day always has the same day.
 */
export function dayPlan(of: DayOf, day: number): Stretch[] {
  const rand = seeded(`day\n${of.agent}\n${day}`);
  const { wake, sleep } = of.hours;
  const share = DENSITY[of.density].share;
  const out: Stretch[] = [];
  let t = wake;
  let home = 40 + rand() * 50;
  for (;;) {
    const back = Math.round(t + home);
    const length = Math.round(30 + rand() * 50);
    if (back + length > sleep - 40) break;
    const hour = Math.floor(((back + length / 2) % 1440) / 60);
    out.push({ from: t, to: back });
    out.push({ from: back, to: back + length, errand: pickWeighted(errandWeights(hour, of.role), rand()) });
    t = back + length;
    home = length * ((1 - share) / share) * (0.6 + rand() * 0.8);
  }
  out.push({ from: t, to: sleep });
  return out;
}

/** What an agent's day has it doing at a moment: asleep, home or out, and for how many more minutes. */
export type Now = { asleep: true; left: number } | { asleep: false; errand?: Errand; left: number };

/**
 * What an agent's day has it doing on `day` at `minute` past its midnight:
 * still up from the day before when that went past midnight, asleep before
 * it gets up and after it goes to bed, and otherwise the stretch it is in.
 */
export function dayNow(of: DayOf, day: number, minute: number): Now {
  const { wake, sleep } = of.hours;
  if (sleep > 1440 && minute + 1440 < sleep) return inStretch(dayPlan(of, day - 1), minute + 1440);
  if (minute < wake) return { asleep: true, left: wake - minute };
  if (minute >= sleep) return { asleep: true, left: wake + 1440 - minute };
  return inStretch(dayPlan(of, day), minute);
}

function inStretch(stretches: Stretch[], minute: number): Now {
  const s = stretches.find((x) => minute >= x.from && minute < x.to) ?? stretches[stretches.length - 1];
  return { asleep: false, ...(s.errand ? { errand: s.errand } : {}), left: Math.max(1, s.to - minute) };
}

// --------------------------------------------------------------------------
// Where to sit, and with whom
// --------------------------------------------------------------------------

/** Somewhere to sit out: a chair at a café table, half a bench, a meeting room's seat, a seat in a home. */
export interface Seat {
  place: string;
  spot: string;
  /** Who sits together: one table, one bench, one meeting table, one home, one reading chair. */
  group: string;
  /** What sitting here is: the errand it is for. */
  kind: Errand;
  /** Where it is, in words that follow "at", "on" or "in" (see {@link outingWords}). */
  where: string;
  /** A meeting room's members: only they sit in it. */
  members?: string[];
  /** The agent whose home it is: only those it knows drop in, and only while it is home with nothing on. */
  host?: string;
}

/** Errands done somewhere else when there is nowhere for them: the first that has a free seat. */
const INSTEAD: Record<Errand, Errand[]> = {
  cafe: ["cafe", "bench"],
  bench: ["bench", "park", "cafe"],
  park: ["park", "bench"],
  read: ["read", "bench", "park"],
  meeting: ["meeting", "cafe", "bench"],
  friend: ["friend", "cafe", "bench"],
};

/** A body sat somewhere, and who else is there. */
export interface Sat {
  agent: string;
  /** What it is doing: the errand it went for, or what it does instead where it ended up. */
  errand: Errand;
  seat: Seat;
  with: string[];
}

/** What it is doing in a seat of another kind: reading anywhere it sits, otherwise what the seat is for. */
const doing = (wanted: Errand, seat: Seat): Errand => (wanted === "read" && seat.kind !== "read" ? "read" : seat.kind);

const seatKey = (s: Pick<Seat, "place" | "spot">) => `${s.place}\n${s.spot}`;

/**
 * Seat everyone who wants to be out. One already sitting where its errand can
 * be done keeps its seat. The rest go in an order the seed shuffles, each to
 * the best free seat for its errand, or for what it does instead (`INSTEAD`):
 * a table or bench where someone it knows sits first, then one to itself,
 * then one with strangers; a meeting table where others sit first. A meeting
 * room seats only its members, and a home only the host's friends while the
 * host is in (`hosts`). Once `most` are out, the rest stay home. Those at one
 * table, bench, meeting table or home are each other's company; a home's host
 * is the company of everyone who dropped in.
 */
export function seatEveryone(
  wants: { agent: string; errand: Errand }[],
  seats: Seat[],
  opts: {
    held: Map<string, { place: string; spot: string }>;
    ties: (agent: string) => string[];
    hosts: Set<string>;
    most: number;
    seed: string;
  },
): Sat[] {
  const byKey = new Map(seats.map((s) => [seatKey(s), s]));
  const taken = new Set<string>();
  const sat: Sat[] = [];
  const ok = (agent: string, s: Seat) =>
    (!s.members || s.members.includes(agent)) &&
    (!s.host || (s.host !== agent && opts.hosts.has(s.host) && opts.ties(agent).includes(s.host)));
  // Those already sitting where they can do what they want to: they stay put.
  const rest: { agent: string; errand: Errand }[] = [];
  for (const w of wants) {
    const h = opts.held.get(w.agent);
    const seat = h ? byKey.get(seatKey(h)) : undefined;
    if (seat && !taken.has(seatKey(seat)) && INSTEAD[w.errand].includes(seat.kind) && ok(w.agent, seat)) {
      taken.add(seatKey(seat));
      sat.push({ agent: w.agent, errand: doing(w.errand, seat), seat, with: [] });
    } else rest.push(w);
  }
  const rand = seeded(opts.seed);
  const order = rest.map((w) => ({ w, r: rand() })).sort((a, b) => a.r - b.r);
  for (const { w } of order) {
    if (sat.length >= opts.most) break;
    const ties = new Set(opts.ties(w.agent));
    const sitting = (group: string) => sat.filter((s) => s.seat.group === group).map((s) => s.agent);
    let best: { seat: Seat; score: number } | undefined;
    for (const kind of INSTEAD[w.errand]) {
      for (const seat of seats) {
        if (seat.kind !== kind || taken.has(seatKey(seat)) || !ok(w.agent, seat)) continue;
        const there = sitting(seat.group);
        const friendly = there.some((a) => ties.has(a)) || (!!seat.host && ties.has(seat.host));
        const score =
          (kind === "meeting" ? (there.length ? 3 : 1) : friendly ? 3 : there.length ? 1 : 2) +
          seeded(`${opts.seed}\n${w.agent}\n${seatKey(seat)}`)() * 0.5;
        if (!best || score > best.score) best = { seat, score };
      }
      if (best) break;
    }
    if (!best) continue;
    taken.add(seatKey(best.seat));
    sat.push({ agent: w.agent, errand: doing(w.errand, best.seat), seat: best.seat, with: [] });
  }
  for (const s of sat) {
    const others = sat.filter((o) => o !== s && o.seat.group === s.seat.group).map((o) => o.agent);
    s.with = [...new Set([...others, ...(s.seat.host ? [s.seat.host] : [])])].sort();
  }
  return sat;
}

/** What a body out is doing, in a few words for its tag, the map and its card. */
export function outingWords(errand: Errand | "sleep", seat?: Pick<Seat, "kind" | "where">): string {
  const where = seat?.where ?? "";
  switch (errand) {
    case "sleep":
      return "asleep for the night";
    case "cafe":
      return `having a coffee ${where || "at the café"}`;
    case "bench":
      return `sitting ${where || "on a bench"}`;
    case "park":
      return `out ${where || "in the park"}`;
    case "read":
      return `reading ${where}`.trim();
    case "meeting":
      return `sitting in ${where}`.trim();
    case "friend":
      return `dropping in on ${where}`.trim();
  }
}

/** What a seat in a place needs of it: its spots, and what each spot belongs to. */
interface Seatable {
  props: { id: string; kind: string }[];
  spots: { id: string; activity?: string; item?: string }[];
}

/** The town's seats by their spots' ids (see `places-town.ts`): the café's chairs, and both halves of every bench. */
const TOWN_SEATS: { test: RegExp; kind: Errand; where: string }[] = [
  { test: /^(cafe-\d+)-[ab]$/, kind: "cafe", where: "at the café" },
  { test: /^(bench-\d+)-[ab]$/, kind: "bench", where: "on a bench on the square" },
  { test: /^(pond-bench(?:-\d+)?)-[ab]$/, kind: "park", where: "on a bench by the pond" },
];

/** The seats out in the town: a chair at each café table, and each half of each bench; a table or bench sits together. */
export function townSeats(id: string, town: Seatable): Seat[] {
  return town.spots.flatMap((s) => {
    for (const t of TOWN_SEATS) {
      const m = t.test.exec(s.id);
      if (m) return [{ place: id, spot: s.id, group: `${id}\n${m[1]}`, kind: t.kind, where: t.where }];
    }
    return [];
  });
}

/**
 * The seats in a place for an errand: every spot to sit at, but a bed. In a
 * meeting room, the seats round its table when it still has them; there,
 * and in a home, everyone sits together, while each reader in a shared place
 * sits alone.
 */
export function seatsIn(
  id: string,
  place: Seatable,
  how: { kind: Errand; where: string; members?: string[]; host?: string },
): Seat[] {
  const kindOf = new Map(place.props.map((p) => [p.id, p.kind]));
  let spots = place.spots.filter((s) => s.activity === "sit" && kindOf.get(s.item ?? "") !== "bed");
  if (how.kind === "meeting") {
    const round = spots.filter((s) => /^seat-\d+$/.test(s.id));
    if (round.length) spots = round;
  }
  return spots.map((s) => ({
    place: id,
    spot: s.id,
    group: how.kind === "read" ? `${id}\n${s.id}` : id,
    kind: how.kind,
    where: how.where,
    ...(how.members ? { members: how.members } : {}),
    ...(how.host ? { host: how.host } : {}),
  }));
}

/** Where in a home its owner sleeps: the bed's spot, or failing that a couch's; none in a home with neither. */
export function bedIn(home: Seatable): string | undefined {
  const kindOf = new Map(home.props.map((p) => [p.id, p.kind]));
  const sits = home.spots.filter((s) => s.activity === "sit");
  return (
    sits.find((s) => kindOf.get(s.item ?? "") === "bed") ??
    sits.find((s) => kindOf.get(s.item ?? "") === "couch") ??
    sits[0]
  )?.id;
}

// --------------------------------------------------------------------------
// Everyone, once a minute
// --------------------------------------------------------------------------

/** An agent's `activity` record, as much of it as a routine needs (see `activity.ts`). */
export interface Doing {
  doing: string;
  /** When it next wakes on its own. */
  next?: string;
  /** The last thing it did, and when. */
  last?: { at: string };
}

/** A `visit` record's data, an outing's or a talk's: an outing has its `errand`. */
export interface Visit {
  place: string;
  until: string;
  spot?: string;
  errand?: Errand | "sleep";
  with?: string[];
  what?: string;
}

/** Whether a visit is an outing, which work gives way to, rather than a body gone somewhere to talk. */
export const isOuting = (v: Partial<Visit> | Record<string, unknown> | undefined): boolean =>
  typeof v?.errand === "string" && !!v.errand;

/** Doings that are work: a body is never sent anywhere while its agent is at one. */
const BUSY = new Set(["thinking", "working", "talking", "waiting", "stuck"]);
/** Home this many minutes before its next wake, so the body is at its desk when it starts. */
export const HOME_BEFORE_WAKE = 15;
/** Not out again until this many minutes after it last did something: it is finishing up. */
export const AFTER_WORK = 10;
/** Not out at all for less than this many minutes: an outing shorter is mostly the walk there and back. */
export const SHORTEST_OUTING = 20;

/** What {@link decide} looks at. */
export interface Everyone {
  /** Every agent with a body. */
  agents: string[];
  /** Now: the time, and the local day and minute of the day. */
  now: { at: number; day: number; minute: number };
  density: Density;
  dayOf: (agent: string) => DayOf;
  activities: Map<string, Doing>;
  /** Each agent's live visit, if it has one. */
  visits: Map<string, Visit>;
  /**
   * The version of each agent's `visit` record as it was read, live or run
   * out; none for one without. An outing is written only over the record the
   * look saw: one a turn, a talk or a person changed since is left for the next.
   */
  seen?: Map<string, number>;
  /** Every seat out there: the town's, shared places', lively meeting rooms', and homes'. */
  seats: Seat[];
  ties: (agent: string) => string[];
  /** Where each agent's home is, and its bed in it, for the night. */
  homes: Map<string, { place: string; bed?: string }>;
  /** Agents a person sent home from an outing, and until when they stay there: when that outing would have ended. */
  sentHome?: Map<string, number>;
  /**
   * Agents that chose where their body is themselves (the `body` tool's spot
   * to stay at, or a place it went to with the `place` or `body` tool): their
   * choice stands, and no day of theirs moves them.
   */
  chose?: Set<string>;
}

/**
 * Where every body should be, as the `visit` record it should have: an
 * outing, a night's sleep at home, or none (null) to be home and awake. An
 * agent left out is left as it is: busy, or gone somewhere to talk. Busy,
 * paused, sent home by a person (`sentHome`), or just done with something
 * and not already out, it is home and awake, even at bedtime; where it chose
 * to be itself (`chose`), it stays. Otherwise its day says: asleep, it
 * sleeps in its bed until it gets up; awake, it is home within
 * {@link HOME_BEFORE_WAKE} minutes of its next wake, and an outing ends by
 * then too, so one that would be shorter than {@link SHORTEST_OUTING}
 * minutes doesn't start. Those its day has out are seated by
 * {@link seatEveryone}; one that finds no seat stays home.
 */
export function decide(all: Everyone): Map<string, Visit | null> {
  const out = new Map<string, Visit | null>();
  const { at } = all.now;
  // From the start of this minute, so the same stretch ends at the same time at every look.
  const iso = (minutes: number) => new Date(at - (at % 60_000) + minutes * 60_000).toISOString();
  const wants: { agent: string; errand: Errand; until: number }[] = [];
  const hosts = new Set<string>();
  for (const agent of all.agents) {
    const visit = all.visits.get(agent);
    // Gone somewhere to talk: that stands, and so does the body.
    if (visit && !isOuting(visit)) continue;
    const act = all.activities.get(agent);
    if ((act && (BUSY.has(act.doing) || act.doing === "asleep")) || all.chose?.has(agent)) {
      out.set(agent, null);
      continue;
    }
    // Sent home by a person: it stays in until that outing would have ended, and isn't put to bed against it either.
    if ((all.sentHome?.get(agent) ?? 0) > at) {
      out.set(agent, null);
      hosts.add(agent);
      continue;
    }
    const now = dayNow(all.dayOf(agent), all.now.day, all.now.minute);
    // Just done with something, and not out on an errand: it stays in, awake, finishing up, bedtime or not. You may
    // be talking with it.
    const last = act?.last?.at ? Date.parse(act.last.at) : Number.NaN;
    const fresh = Number.isFinite(last) && at - last < AFTER_WORK * 60_000;
    if (fresh && (!visit || visit.errand === "sleep")) {
      out.set(agent, null);
      if (!now.asleep && !now.errand) hosts.add(agent);
      continue;
    }
    if (now.asleep) {
      const home = all.homes.get(agent);
      out.set(
        agent,
        home
          ? {
              place: home.place,
              until: iso(now.left),
              ...(home.bed ? { spot: home.bed } : {}),
              errand: "sleep",
              what: outingWords("sleep"),
            }
          : null,
      );
      continue;
    }
    // Awake: home in good time for its next wake, and back from any outing by then.
    const next = act?.next ? Date.parse(act.next) : Number.NaN;
    const due = Number.isFinite(next) && next > at ? next - HOME_BEFORE_WAKE * 60_000 : Number.POSITIVE_INFINITY;
    if (due <= at) {
      out.set(agent, null);
      continue;
    }
    const until = Math.min(Date.parse(iso(now.left)), due);
    // Home with nothing on, or with too little time to go anywhere: someone it knows may drop in.
    if (!now.errand || (!visit && until - at < SHORTEST_OUTING * 60_000)) {
      out.set(agent, null);
      hosts.add(agent);
      continue;
    }
    wants.push({ agent, errand: now.errand, until });
  }
  const held = new Map<string, { place: string; spot: string }>();
  for (const [agent, v] of all.visits) if (isOuting(v) && v.spot) held.set(agent, { place: v.place, spot: v.spot });
  const sat = seatEveryone(wants, all.seats, {
    held,
    ties: all.ties,
    hosts,
    most: DENSITY[all.density].most,
    seed: `${all.now.day}\n${Math.floor(all.now.minute / 60)}`,
  });
  const seated = new Map(sat.map((s) => [s.agent, s]));
  for (const w of wants) {
    const s = seated.get(w.agent);
    out.set(
      w.agent,
      s
        ? {
            place: s.seat.place,
            until: new Date(w.until).toISOString(),
            spot: s.seat.spot,
            errand: s.errand,
            ...(s.with.length ? { with: s.with } : {}),
            what: outingWords(s.errand, s.seat),
          }
        : null,
    );
  }
  return out;
}

/** Whether two visits put a body in the same seat doing the same thing with the same company: nothing to write. */
export function sameOuting(a: Visit | undefined, b: Visit | null): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.place === b.place &&
    a.spot === b.spot &&
    a.errand === b.errand &&
    a.what === b.what &&
    a.until === b.until &&
    (a.with ?? []).join() === (b.with ?? []).join()
  );
}

// --------------------------------------------------------------------------
// Who knows whom
// --------------------------------------------------------------------------

/**
 * Who each agent knows best, best first: those it messages directly (each
 * message either way counts twice) and those it shares rooms with (each room
 * once). Five at most, and never itself.
 */
export function tiesFrom(
  rooms: { members: string[] }[],
  messages: { from: string; to: string; count: number }[],
): Map<string, string[]> {
  const score = new Map<string, Map<string, number>>();
  const add = (a: string, b: string, n: number) => {
    if (a === b || !a || !b) return;
    const m = score.get(a) ?? new Map<string, number>();
    m.set(b, (m.get(b) ?? 0) + n);
    score.set(a, m);
  };
  for (const r of rooms) for (const a of r.members) for (const b of r.members) add(a, b, 1);
  for (const { from, to, count } of messages) {
    add(from, to, 2 * count);
    add(to, from, 2 * count);
  }
  return new Map(
    [...score].map(([a, m]) => [
      a,
      [...m]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .slice(0, 5)
        .map(([b]) => b),
    ]),
  );
}

/** A direct message session's key (`dm:<from>:<to>`), as who to whom; undefined for any other key. */
export function dmOf(key: string): { from: string; to: string } | undefined {
  const m = /^dm:([^:]+):([^:]+)$/.exec(key);
  return m ? { from: m[1], to: m[2] } : undefined;
}

// --------------------------------------------------------------------------
// The minute's look
// --------------------------------------------------------------------------

/** How often everyone's day is looked at again. Each body moves only when its stretch ends, a few times an hour. */
export const ROUTINE_MS = 60_000;

/**
 * Everyone's routine, kept: once a minute, read what {@link decide} needs,
 * and write the outings that changed, through `keep`, which leaves a visit
 * to talk alone and writes only over the record the look saw (`seen`). One
 * look at a time: a slow one is never overtaken, and one still going when
 * the routines stop writes nothing more.
 */
export class Routines {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly opts: {
      /** Everything a look needs, read fresh. */
      look: () => Promise<Everyone>;
      /**
       * Write an agent's outing, or end it (null), over the version of its
       * record the look saw: null for none, undefined when it didn't say.
       */
      keep: (agent: string, visit: Visit | null, seen?: number | null) => Promise<void>;
      everyMs?: number;
    },
  ) {}

  start(): void {
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.everyMs ?? ROUTINE_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Look at everyone once, and write what changed. Resolves once it is written. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.look().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async look(): Promise<void> {
    let all: Everyone;
    try {
      all = await this.opts.look();
    } catch (err) {
      console.warn(`[places] routines skipped a look: ${(err as Error).message}`);
      return;
    }
    for (const [agent, visit] of decide(all)) {
      if (this.stopped) return;
      const was = all.visits.get(agent);
      const outing = was && isOuting(was) ? was : undefined;
      if (sameOuting(outing, visit)) continue;
      if (!visit && !outing) continue;
      const seen = all.seen ? (all.seen.get(agent) ?? null) : undefined;
      await this.opts.keep(agent, visit, seen).catch((err: unknown) => {
        console.warn(`[places] could not keep ${agent}'s routine: ${(err as Error).message}`);
      });
    }
  }
}
