/**
 * A live session: one person talking with one agent, out loud, for a while.
 *
 * Limits stand in for the per-turn ceilings that do not fit a call. On local
 * hardware the cost is GPU time rather than money, but an unbounded session
 * is still a bug: a tab left open should not hold the speech stages forever.
 */

import { randomBytes } from "node:crypto";
import type { Body } from "./cues.js";

export interface LiveSessionLimits {
  /** Longest a session runs, start to finish. */
  maxMinutes: number;
  /** Longest it sits without a turn before it ends itself. */
  idleMinutes: number;
  /** Most turns it takes. */
  maxTurns: number;
}

export interface LiveSession {
  id: string;
  /** The agent talking, in voice mode. Undefined is the default agent. */
  agent?: string;
  /** Open string: "web" today; later "discord-voice", "phone". */
  transport: string;
  /** The conversation the turns are kept in. */
  sessionId: string;
  startedAt: string;
  lastTurnAt?: string;
  turns: number;
  limits: LiveSessionLimits;
  /** What the surface shows the agent with, if anything: the moves its cues can make. */
  body?: Body;
  endedAt?: string;
  endReason?: string;
}

/** Something the person or the transport can be told: the session ended, or a limit was hit. */
export class LiveSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveSessionError";
  }
}

/** The live sessions a runtime holds. In memory: a session does not outlive the process that hears it. */
export class LiveSessions {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  start(input: {
    agent?: string;
    transport: string;
    sessionId: string;
    limits: LiveSessionLimits;
    body?: Body;
  }): LiveSession {
    const session: LiveSession = {
      id: `live-${randomBytes(4).toString("hex")}`,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.body ? { body: input.body } : {}),
      transport: input.transport,
      sessionId: input.sessionId,
      startedAt: this.now().toISOString(),
      turns: 0,
      limits: input.limits,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** A session as it is now: one past a limit is ended on the way out, with the reason. */
  get(id: string): LiveSession | undefined {
    const session = this.sessions.get(id);
    if (session && !session.endedAt) {
      const over = this.overLimit(session);
      if (over) this.end(id, over);
    }
    return session;
  }

  list(): LiveSession[] {
    return [...this.sessions.keys()].map((id) => this.get(id) as LiveSession);
  }

  /** Count a turn, or refuse it with the reason the session cannot take one. */
  beginTurn(id: string): LiveSession {
    const session = this.get(id);
    if (!session) throw new LiveSessionError("There is no live session with that id.");
    if (session.endedAt) throw new LiveSessionError(`This session has ended: ${session.endReason}.`);
    if (session.turns >= session.limits.maxTurns) {
      this.end(id, `it reached its limit of ${session.limits.maxTurns} turns`);
      throw new LiveSessionError(`This session has ended: ${session.endReason}.`);
    }
    session.turns += 1;
    session.lastTurnAt = this.now().toISOString();
    return session;
  }

  end(id: string, reason = "it was ended"): LiveSession | undefined {
    const session = this.sessions.get(id);
    if (session && !session.endedAt) {
      session.endedAt = this.now().toISOString();
      session.endReason = reason;
    }
    return session;
  }

  private overLimit(session: LiveSession): string | undefined {
    const now = this.now().getTime();
    if (now - Date.parse(session.startedAt) > session.limits.maxMinutes * 60_000) {
      return `it reached its limit of ${session.limits.maxMinutes} minutes`;
    }
    const last = Date.parse(session.lastTurnAt ?? session.startedAt);
    if (now - last > session.limits.idleMinutes * 60_000) {
      return `nothing was said for ${session.limits.idleMinutes} minutes`;
    }
    return undefined;
  }
}
