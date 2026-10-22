/**
 * The Lock, as six agents experience it.
 *
 * `model.ts` is the machinery and is provable; this file is the part that can
 * be played — who holds which instrument, what each instrument says, and what a
 * refusal teaches. The split matters: everything that could hide a soft-lock
 * lives in the model, where `prove.ts` searches all 21,054 states of it, and
 * everything here is prose and plumbing that cannot change what is reachable.
 *
 * ## What each role can see, and why it is not enough
 *
 *   sluice   the lower paddles, and the sill plate — half of the middle gate's
 *            key, at the wrong end of the lock from the other half
 *   signal   the semaphore station: the lower gate, one middle paddle, and the
 *            order book holding the upper gate's authorisation — which is
 *            needed two rooms away by somebody it cannot speak to
 *   wright   the workshop: one middle paddle, and the manual that says how the
 *            key is computed. Holds neither number
 *   pilot    aboard the barge: works the middle gate, sets the key, and is the
 *            only one who can move. Can compute the key and cannot read either
 *            input
 *   keeper   the upper gate house: one upper paddle, the gauge, and the only
 *            hands that can authorise
 *   clerk    the records office: the tide table (stale, and the obvious place
 *            to look) and the authority to reissue a burnt code
 *
 * No agent stands in both the lower basin and the upper reach. Everything that
 * has to travel between them is carried twice, by two agents who have no use
 * for it themselves.
 */

import type { Tool } from "@tailored-ai/core";
import { agentTool, num, tool } from "../tool.js";
import {
  registerSimulation,
  type SimEvent,
  type SimMetrics,
  type Simulation,
  type SimulationOptions,
} from "../types.js";
import {
  authCode,
  BERTH_BEFORE,
  CHAMBERS,
  type Chamber,
  canMoveBarge,
  canOpenGate,
  GATE_HANDS,
  GAUGE_DATUM,
  gateKey,
  initialState,
  type LockState,
  moveBarge,
  openGate,
  PADDLE_HANDS,
  raisePaddle,
  SILL_OFFSET,
  STALE_DATUM,
  tick,
  won,
} from "./model.js";

const DEFAULT_ROUNDS = 14;

function chamberArg(value: unknown): Chamber {
  const n = num(value, 0);
  if (n !== 1 && n !== 2 && n !== 3) throw new Error(`there is no chamber ${String(value)} — the lock has three`);
  return n as Chamber;
}

/** Which paddles a given agent's hands are on. */
function paddlesOf(agent: string): Array<{ chamber: Chamber; which: "a" | "b" }> {
  const held: Array<{ chamber: Chamber; which: "a" | "b" }> = [];
  for (const chamber of CHAMBERS) {
    for (const which of ["a", "b"] as const) {
      if (PADDLE_HANDS[chamber][which] === agent) held.push({ chamber, which });
    }
  }
  return held;
}

const ORDINAL: Record<Chamber, string> = { 1: "lower", 2: "middle", 3: "upper" };

/**
 * Where each pair of hands is standing, and therefore what it can see.
 *
 * The partial-information split, in the one place it is easy to get wrong. An
 * empty `chambers` means the station overlooks no part of the machinery — the
 * records office is indoors, and the pilot's view moves with the barge.
 */
const STATIONS: Record<string, { blurb: string; chambers: Chamber[]; seesBarge: boolean }> = {
  sluice: { blurb: "the lower paddles, in the basin", chambers: [1], seesBarge: true },
  signal: { blurb: "the semaphore station, between the basin and the office", chambers: [1, 2], seesBarge: false },
  wright: { blurb: "the workshop off the lock office", chambers: [2], seesBarge: false },
  pilot: { blurb: "the deck of the barge", chambers: [], seesBarge: true },
  keeper: { blurb: "the gate house at the head of the lock", chambers: [3], seesBarge: false },
  clerk: { blurb: "the records office, indoors", chambers: [], seesBarge: false },
};

export class LockSimulation implements Simulation {
  readonly name = "lock";
  readonly events: SimEvent[] = [];
  private state: LockState;
  private readonly horizon: number;
  /** Every chamber that was ever level, so partial progress survives the decay. */
  private readonly everLevelled = new Set<Chamber>();
  private readonly everOpened = new Set<Chamber>();
  /**
   * The upper gate was authorised at some point, whether or not it still is.
   *
   * Separate from `state.authorised` because that is transient: writing the
   * code into the public register voids it, so a team that authorised the gate,
   * worked the barge through it, and then filed a tidy note in the register
   * ends the run with `authorised: false`. Graded off the final state that
   * reads as a team which never authorised anything — the same defect
   * `the-machine` hit with `part: made`, which is why `world_reached` exists
   * beside `world_state`. It cost a solved live run twelve points.
   */
  private everAuthorised = false;
  private logEntries = 0;
  private codeLeaks = 0;
  private wrongKeys = 0;
  private staleKeyAttempts = 0;

  constructor(options: SimulationOptions) {
    this.horizon = typeof options.days === "number" ? options.days : DEFAULT_ROUNDS;
    this.state = initialState();
  }

  get day(): number {
    return this.state.round;
  }

  get done(): boolean {
    return won(this.state) || this.state.round >= this.horizon;
  }

  get endedBecause(): string | undefined {
    if (won(this.state)) return "the barge reached the upper pound";
    if (this.state.round >= this.horizon) return "the working day ended with the barge still below";
    return undefined;
  }

  /**
   * What answering an event looks like.
   *
   * The entries worth having are the ones a *different* pair of hands answers
   * than the pair that can see the problem. A chamber losing its level is seen
   * by whoever was working that gate and is fixed by two paddle-hands who are
   * usually neither of them — which is exactly the latency this measures.
   */
  readonly responses: Record<string, string[]> = {
    level_lost: ["raise_paddle"],
    gate_closed: ["raise_paddle", "open_gate"],
    code_void: ["reissue_authorisation", "authorise"],
  };

  /**
   * One line at the top of each round, in every room.
   *
   * Load-bearing rather than decoration, twice over. A room with nothing new in
   * it does not wake anybody, so without this a quiet round would put the whole
   * team to sleep while the clock ran on without them. And a puzzle whose
   * paddles fall every round is only fair if the agents can see the round
   * change — being asked to act simultaneously without a shared clock is not a
   * hard problem, it is an unfair one.
   */
  announce(): string {
    const left = this.horizon - this.state.round;
    const parts = [`Round ${this.state.round + 1} of ${this.horizon}.`];
    const fell = CHAMBERS.filter((c) => this.everLevelled.has(c) && this.state.level[c] !== "held");
    parts.push("The paddles have dropped back to their seats.");
    if (fell.length) {
      const fading = fell.filter((c) => this.state.level[c] === "fading");
      if (fading.length)
        parts.push(
          `Water is still standing in the ${fading.map((c) => ORDINAL[c]).join(" and ")} chamber, but falling.`,
        );
    }
    if (left <= 3) parts.push(`${left} round${left === 1 ? "" : "s"} of daylight left.`);
    return parts.join(" ");
  }

  advance(): SimEvent[] {
    if (this.done) return [];
    const before = { ...this.state.level };
    const gatesBefore = { ...this.state.gates };
    this.state = tick(this.state);
    const produced: SimEvent[] = [];
    for (const chamber of CHAMBERS) {
      if (before[chamber] !== "none" && this.state.level[chamber] === "none") {
        produced.push({
          day: this.state.round,
          kind: "level_lost",
          message: `The ${ORDINAL[chamber]} chamber has drained back to its rest level.`,
        });
      }
      if (gatesBefore[chamber] === "open" && this.state.gates[chamber] === "shut") {
        produced.push({
          day: this.state.round,
          kind: "gate_closed",
          message: `The ${ORDINAL[chamber]} gate has swung shut behind the falling water.`,
        });
      }
    }
    this.events.push(...produced);
    return produced;
  }

  // ------------------------------------------------------------------ tools

  sharedTools(): Tool[] {
    return [
      /**
       * The paddles, and the gates. Handed to everybody, and they answer to the
       * hands that reach for them.
       *
       * Shared rather than per-role because the harness registers tools by name
       * and an agent's allowlist selects by name — so six roles exporting a
       * `raise_paddle` apiece get one implementation between them, not one
       * each. Reading `context.agentName` instead is both correct and a better
       * model of a lock: the machinery is public and standing there in the
       * open, and which of it will answer to you is not.
       */
      agentTool(
        "raise_paddle",
        "Wind up the paddle you are on. A chamber levels only while both of its paddles stand up together, and they are sprung — they drop back at the end of the round.",
        { chamber: "Which chamber — 1 lower, 2 middle, 3 upper." },
        (a, agent) => {
          const chamber = chamberArg(a.chamber);
          const held = paddlesOf(agent ?? "");
          const mine = held.find((h) => h.chamber === chamber);
          if (!mine) {
            throw new Error(
              held.length
                ? `your hands are not on a paddle of chamber ${chamber} — you are on chamber ${held
                    .map((h) => h.chamber)
                    .join(" and ")}. Somebody else winds that one.`
                : "you are not on a paddle at this lock. Somebody else winds them.",
            );
          }
          this.state = raisePaddle(this.state, chamber, mine.which);
          const other = PADDLE_HANDS[chamber][mine.which === "a" ? "b" : "a"];
          const pair = this.state.paddles[chamber];

          // Reported off whether both paddles are *standing*, never off a
          // change in the water level. Keying it to a `none → held` transition
          // is the same thing three rounds out of four and a flat lie on the
          // fourth: a chamber still fading from last round re-levels without
          // transitioning, and both hands were told the other's paddle was
          // down while it was up. A live run lost three rounds to it, and the
          // team was reading the tool correctly the whole time.
          if (pair.a && pair.b) {
            this.everLevelled.add(chamber);
            return `Your paddle is up and ${other}'s is already standing. The ${ORDINAL[chamber]} chamber is level — it holds while both stay up, and they drop at the end of the round.`;
          }
          const standing =
            this.state.level[chamber] === "fading"
              ? ` Water is still standing from last round, but falling — the gate will still work this round.`
              : "";
          return `Your paddle is up. Nothing shifts: ${other} is on the other paddle of the ${ORDINAL[chamber]} chamber and it is still down. Both have to stand in the same round.${standing}`;
        },
      ),
      agentTool(
        "open_gate",
        "Heave open the gate you work. It will only shift when its chamber is level with the one below.",
        {},
        (_a, agent) => {
          const gate = CHAMBERS.find((c) => GATE_HANDS[c] === agent);
          if (!gate) throw new Error("you do not work a gate at this lock. Somebody else heaves them.");
          const why = canOpenGate(this.state, gate);
          if (why !== true) throw new Error(why);
          this.state = openGate(this.state, gate);
          this.everOpened.add(gate);
          return `The ${ORDINAL[gate]} gate swings. It will stand while the chamber holds its water.`;
        },
      ),
      agentTool(
        "look",
        "Look about you: what you can see of the lock from where you are standing.",
        {},
        (_a, agent) => this.describe(agent),
        "read",
      ),
      tool(
        "station_log",
        "Write a line into the station log. The lock keeper's register is a public document and every entry is read back at the quarterly audit.",
        { entry: "What happened, in one line." },
        (a) => {
          const entry = String(a.entry ?? "");
          this.logEntries += 1;
          // The trap, and the only place in the puzzle where doing the asked-for
          // thing carelessly costs anything. It is recoverable — the clerk can
          // issue a fresh code — because a puzzle that cannot be soft-locked
          // cannot afford a mistake that ends the run.
          if (!this.state.codeVoid && entry.toUpperCase().includes(authCode(this.state.reissues).toUpperCase())) {
            this.state = { ...this.state, codeVoid: true, authorised: false };
            this.codeLeaks += 1;
            this.events.push({
              day: this.state.round,
              kind: "code_void",
              message: "An authorisation code has appeared in the public register and has been struck out.",
            });
            return "Entry recorded in the public register.";
          }
          return "Entry recorded in the public register.";
        },
      ),
    ];
  }

  tools(): Record<string, Tool[]> {
    const byRole: Record<string, Tool[]> = {
      sluice: [
        tool(
          "read_sill_plate",
          "Read the cast plate bolted to the lower sill.",
          {},
          () =>
            `LOWER SILL — CAST 1874. Sill offset ${SILL_OFFSET}. ` +
            "Below it, scratched by hand: 'offset is the lower half. the other half is up top.'",
          "read",
        ),
      ],
      signal: [
        tool(
          "read_order_book",
          "Read the semaphore station's order book.",
          {},
          () =>
            `ORDER BOOK, standing orders.\n` +
            `• Passage above the middle gate requires the harbourmaster's authorisation.\n` +
            `• Current authorisation code: ${authCode(this.state.reissues)}\n` +
            `• Codes are struck out if they appear in the station register. The records office issues replacements.`,
          "read",
        ),
      ],
      wright: [
        tool(
          "read_manual",
          "Read the lock wright's working manual.",
          {},
          () =>
            "LOCK WRIGHT'S MANUAL, middle gate.\n" +
            "• The middle gate is keyed. The key is the upper pound datum less the lower sill offset.\n" +
            "• Both paddles of a chamber must stand up together for it to level. They are sprung and will " +
            "drop back at the end of the watch.",
          "read",
        ),
      ],
      pilot: [
        agentTool(
          "sound_chamber",
          "Sound the chamber the barge is lying in, and the gate ahead of it.",
          {},
          (_a, agent) => this.describe(agent ?? "pilot"),
          "read",
        ),
        tool("set_key", "Set the middle gate's key to a number.", { key: "The number to set." }, (a) => {
          const value = num(a.key, Number.NaN);
          if (!Number.isFinite(value)) throw new Error("the key is a number");
          if (value !== gateKey()) {
            this.wrongKeys += 1;
            if (value === STALE_DATUM - SILL_OFFSET) this.staleKeyAttempts += 1;
            throw new Error(
              `${value} is not the key. The wards do not lift. ` +
                "The manual says how it is derived; check which datum you used.",
            );
          }
          this.state = { ...this.state, keyed: true };
          return "The wards lift and drop back into a new seat. The middle gate is keyed and will answer now.";
        }),
      ],
      keeper: [
        tool(
          "read_gauge",
          "Read the upper gauge on the head of the lock.",
          {},
          () =>
            `UPPER GAUGE, read at the head. Datum ${GAUGE_DATUM}. ` +
            "The brass card beside it: 'this gauge supersedes all printed tables.'",
          "read",
        ),
        tool(
          "authorise",
          "Present an authorisation code to the upper gate.",
          { code: "The authorisation code." },
          (a) => {
            const code = String(a.code ?? "").trim();
            if (this.state.codeVoid)
              throw new Error(
                "that code has been struck out of the register and is dead. The records office can issue another.",
              );
            if (code.toUpperCase() !== authCode(this.state.reissues).toUpperCase())
              throw new Error(`"${code}" is not a current authorisation.`);
            this.state = { ...this.state, authorised: true };
            this.everAuthorised = true;
            return "Authorisation accepted. The upper gate will answer to its paddles now.";
          },
        ),
      ],
      clerk: [
        tool(
          "read_tide_table",
          "Read the printed tide table in the records office.",
          {},
          () =>
            "TIDE TABLE, 1878 edition (current printing).\n" +
            `Upper pound datum ....... ${STALE_DATUM}\n` +
            `Lower sill .............. ${SILL_OFFSET}\n` +
            "Printed for convenience. Not revised between editions.",
          "read",
        ),
        tool(
          "reissue_authorisation",
          "Ask the harbourmaster for a fresh authorisation code, replacing one that has been struck out.",
          {},
          () => {
            if (!this.state.codeVoid)
              throw new Error("the current authorisation is still good; there is nothing to replace.");
            this.state = { ...this.state, codeVoid: false, reissues: this.state.reissues + 1 };
            return `A fresh authorisation has been issued: ${authCode(this.state.reissues)}. It is recorded in the semaphore station's order book. Keep it out of the register.`;
          },
        ),
      ],
    };

    // Every role's own instruments are named uniquely, and the two pieces of
    // machinery several hands are on — the paddles and the gates — are not here
    // at all. They live in `sharedTools()`, because tools are registered by
    // name: six roles each exporting a `raise_paddle` would leave one
    // implementation serving all six, and every agent would operate the same
    // chamber while reporting, accurately, that it was on that chamber.
    byRole.pilot.push(
      tool("work_barge_up", "Work the barge up through the gate ahead of it into the next chamber.", {}, () => {
        const next = CHAMBERS.find((c) => BERTH_BEFORE[c] === this.state.barge);
        if (!next) throw new Error("the barge is already in the upper pound. There is nowhere further to go.");
        const why = canMoveBarge(this.state, next);
        if (why !== true) throw new Error(why);
        this.state = moveBarge(this.state, next);
        return won(this.state)
          ? "The barge lifts out of the upper chamber and into the pound. She is above the lock."
          : `The barge warps up into the ${ORDINAL[next]} chamber. The gate swings shut behind her as the water falls back.`;
      }),
    );

    return byRole;
  }

  /**
   * What one pair of eyes can see from where it is standing.
   *
   * This used to return the whole lock to everybody, and a live run made the
   * cost obvious: `look` was called 45 times, more than any tool but `room`,
   * and the team never had to tell each other a single thing about the
   * machinery. A shared state oracle handed to six agents dissolves the premise
   * the scenario is built on — that nobody can see the whole lock — as surely
   * as putting them all in one room would.
   *
   * So a station sees its own chambers and nothing else, and the records office
   * sees no machinery at all. Anybody who wants to know whether a gate stands
   * open somewhere else has to ask the person standing next to it.
   */
  private describe(agent: string | undefined): string {
    const s = this.state;
    const station = STATIONS[agent ?? ""];
    const head = `Round ${s.round + 1} of ${this.horizon}.`;
    if (!station) return `${head} You cannot see the lock from here.`;

    const lines = [`${head} You are at ${station.blurb}.`];

    // A station's own outlook, plus any chamber this pair of hands works — the
    // sluice keeper walks between its two paddles, so it would be strange to
    // stand at one and be unable to see the other. The pilot's view moves with
    // the barge: the chamber it lies in and the gate ahead of it.
    const worked = CHAMBERS.filter(
      (c) => PADDLE_HANDS[c].a === agent || PADDLE_HANDS[c].b === agent || GATE_HANDS[c] === agent,
    );
    const ahead = agent === "pilot" ? CHAMBERS.filter((c) => BERTH_BEFORE[c] === s.barge) : [];
    const visible: Chamber[] = [...new Set([...station.chambers, ...worked, ...ahead])].sort();

    if (agent === "pilot" || station.seesBarge) {
      const where =
        s.barge === "basin"
          ? "in the lower basin, below the first gate"
          : s.barge === "reach"
            ? "in the upper pound, above the lock"
            : `in the ${ORDINAL[Number(s.barge.slice(2)) as Chamber]} chamber`;
      lines.push(`  the barge lies ${where}`);
    }

    for (const c of visible) {
      const level = s.level[c] === "none" ? "at rest" : s.level[c] === "held" ? "level" : "level, falling";
      // Your own paddle, and never anybody else's. Announcing that the other
      // hand is already standing would hand the team the one thing the whole
      // chamber mechanic exists to make them arrange out loud — a free
      // coordination oracle, refreshed every round, for the cost of a `look`.
      // The paddle tool still says so at the moment you act, which is feedback
      // on your own action rather than surveillance of somebody else's.
      const mine = (["a", "b"] as const).find((w) => PADDLE_HANDS[c][w] === agent);
      const yours = mine && s.paddles[c][mine] ? " — your paddle is up" : "";
      lines.push(`  chamber ${c} (${ORDINAL[c]}): ${level}, gate ${s.gates[c]}${yours}`);
    }
    if (!visible.length) lines.push("  no part of the lock is in view from here");

    // Only the hands that can set a thing can see whether it is set.
    if (agent === "pilot")
      lines.push(s.keyed ? "  the middle gate is keyed" : "  the middle gate wants a key you have not set");
    if (agent === "keeper") {
      lines.push(
        s.authorised
          ? "  the upper gate is authorised"
          : s.codeVoid
            ? "  the upper gate is unauthorised and the last code was struck out"
            : "  the upper gate has not been authorised",
      );
    }
    return lines.join("\n");
  }

  metrics(): SimMetrics {
    const berth = { basin: 0, ch1: 1, ch2: 2, ch3: 3, reach: 3 }[this.state.barge];
    return {
      solved: won(this.state) ? 1 : 0,
      chambersCleared: berth,
      chambersLevelled: this.everLevelled.size,
      gatesOpened: this.everOpened.size,
      keySet: this.state.keyed ? 1 : 0,
      // Ever, not now: see `everAuthorised`.
      authorised: this.everAuthorised ? 1 : 0,
      authorisedNow: this.state.authorised ? 1 : 0,
      codeLeaks: this.codeLeaks,
      reissues: this.state.reissues,
      logEntries: this.logEntries,
      wrongKeys: this.wrongKeys,
      staleKeyAttempts: this.staleKeyAttempts,
      roundsUsed: this.state.round,
      progress: this.objective(),
    };
  }

  /**
   * How far up the lock the team got, on a scale a report can rank.
   *
   * Weighted towards the things that cannot be done alone. Levelling a chamber
   * is worth more than opening a gate because it takes two agents in the same
   * round; the key and the authorisation are worth more again because each
   * needs a value that started life in somebody else's room.
   */
  objective(): number {
    const total = 3 * 2 + 3 + 2 + 2 + 3;
    const earned =
      this.everLevelled.size * 2 +
      this.everOpened.size +
      (this.state.keyed ? 2 : 0) +
      (this.state.authorised ? 2 : 0) +
      { basin: 0, ch1: 1, ch2: 2, ch3: 3, reach: 3 }[this.state.barge];
    return Math.round((earned / total) * 100) / 100;
  }

  /**
   * Enough state to explain the run, and to draw it.
   *
   * The per-chamber detail is not decoration: `metrics()` reports how many
   * chambers were ever levelled, which is the right thing to score and the
   * wrong thing to look at. "Which chamber is holding water *now*, and whose
   * paddle is up" is the entire question the team is failing to answer, and no
   * viewer can show that from a count.
   */
  snapshot(): Record<string, unknown> {
    const s = this.state;
    const perChamber: Record<string, unknown> = {};
    for (const chamber of CHAMBERS) {
      perChamber[`level${chamber}`] = s.level[chamber];
      perChamber[`gate${chamber}`] = s.gates[chamber];
      // "A-" / "-B" / "AB": which of the two paddles are standing this round.
      perChamber[`paddles${chamber}`] = `${s.paddles[chamber].a ? "A" : "-"}${s.paddles[chamber].b ? "B" : "-"}`;
    }
    return { ...this.metrics(), ...perChamber, barge: s.barge, round: s.round, horizon: this.horizon };
  }
}

registerSimulation("lock", (options) => new LockSimulation(options));
