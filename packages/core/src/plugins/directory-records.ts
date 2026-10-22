/**
 * The records behind the directory: what each agent is for (`profile`), the
 * work it has taken on (`commitment`), what it has written up (`doc`), the
 * searches that found nothing (`miss`), and how its page in the web UI is
 * laid out (`page`). See `docs/directory.md` and the design in
 * `docs/ownership-design.md`.
 *
 * Everything here goes through the world-state service, so who sees what is
 * world state's: shared records live in `global`, private ones in the owner's
 * `agent:<name>` scope, and a person through the UI or API sees all of it.
 *
 * Agents may only read these types through `state` (`access.write` is people
 * only). They change their own records through the directory's tools, which
 * check ownership here and then write as the plugin, naming the tool.
 *
 * A room keeps the same records in its own scope, `room:<ref>`, owned by the
 * room: its members change them, and a person's edit to one holds
 * (`directory-rooms.ts`). Its profile is shared, in `global`, so every agent
 * can read what the room is for.
 */
import { createHash } from "node:crypto";
import { parseOrderBy } from "../state/format.js";
import { wordsOf } from "../state/search.js";
import type { StateCaller, StateSearchHit, StateService } from "../state/service.js";
import {
  type FieldCondition,
  type JsonSchema,
  StateConflictError,
  StateError,
  type StateRecord,
  type StateTypeDef,
} from "../state/types.js";
import { systemTimeZone } from "../time/provider.js";
import {
  heldArchiveRefusal,
  heldFields,
  heldRefusal,
  type Lead,
  leadOf,
  overwrites,
  type RoomInfo,
  type RoomSource,
  roomOfOwner,
  roomOwner,
} from "./directory-rooms.js";

export const PROFILE_TYPE = "profile";
export const COMMITMENT_TYPE = "commitment";
export const DOC_TYPE = "doc";
export const MISS_TYPE = "miss";
export const PAGE_TYPE = "page";
export const UPKEEP_TYPE = "upkeep";

/** The kinds `directory search` looks through. Misses are signals for their owner, not answers. */
export const SEARCH_KINDS = [COMMITMENT_TYPE, DOC_TYPE, PROFILE_TYPE] as const;

export const STATUSES = ["open", "waiting", "done", "dropped"] as const;
export type Status = (typeof STATUSES)[number];
/** Statuses of work still in hand: what `about`, `list` and the prompt block show by default. */
export const ACTIVE: Status[] = ["open", "waiting"];

export const AUTONOMY = ["suggest", "tell", "quiet"] as const;
export type Autonomy = (typeof AUTONOMY)[number];
/**
 * The autonomy an agent may give its own commitment. `tell` and `quiet` let it
 * act without asking, so they are a person's to grant: on the State page, or
 * on the agent's page when handing work over.
 */
export const AGENT_AUTONOMY: Autonomy = "suggest";

/** Dated updates kept on a commitment, newest first. The record's history keeps every one. */
export const MAX_UPDATES = 20;

/** Who a commitment came from when a person handed it over on the agent's page. */
export const FROM_PERSON = "a person";

/**
 * The sections every agent's page starts with, in this order, and what the
 * web UI calls them. An agent reorders and hides them and adds its own, by id.
 */
export const PAGE_SECTIONS: Record<string, string> = {
  about: "What I'm for",
  working: "Working on",
  waiting: "Waiting on you",
  results: "Recent results",
  docs: "Docs",
  misses: "Questions nobody could answer",
};

/**
 * Sections an agent can't hide: what waits on a person, and what others asked
 * it that nobody could answer. A page that hid either would look better than
 * the work it shows.
 */
export const KEPT_SECTIONS = ["waiting", "misses"];

/** Sections an agent may add to its page, and the records each lists at most, and by default. */
export const MAX_EXTRA = 6;
export const MAX_EXTRA_LIMIT = 20;
export const DEFAULT_EXTRA_LIMIT = 5;

/** A section an agent added to its page: a titled list of the records a query of its own matches. */
export interface PageSection {
  id: string;
  title: string;
  /** As a `state` query takes it, plus the scopes the agent could see when it added it: the page shows no more. */
  query: { type: string; where?: Record<string, unknown>; orderBy?: string; limit: number; scopes?: string[] };
}

const OWNER = {
  type: "string",
  minLength: 1,
  maxLength: 400,
  description: "The agent this belongs to, or room:<ref> for a room's own.",
} as const;

/** The room a record belongs to, or a lead's commitment was taken on for. */
const ROOM = {
  type: "string",
  minLength: 1,
  maxLength: 300,
  description: "The room it belongs to, or was taken on for, by its ref.",
} as const;

export const PROFILE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["owner"],
  properties: {
    owner: OWNER,
    purpose: { type: "string", maxLength: 600, description: "What the agent is for, in a sentence or two." },
    takesOn: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 200 },
      description: "The kinds of work it accepts.",
    },
    howToAsk: { type: "string", maxLength: 400, description: "How to hand it work: a commitment, a room, a message." },
    room: ROOM,
    note: { type: "string", maxLength: 300, description: "A room's: a sentence or two for people, by its members." },
    noteAt: { type: "string", description: "A room's: when its note was last written." },
    lead: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "A room's: the lead a person chose, which stands in front of config's and the room's creator.",
    },
  },
};

export const COMMITMENT_SCHEMA: JsonSchema = {
  type: "object",
  required: ["owner", "goal", "status"],
  properties: {
    owner: OWNER,
    goal: { type: "string", minLength: 1, maxLength: 300, description: "What it's for, in one line." },
    doneWhen: { type: "string", maxLength: 500, description: "How anyone can tell it's finished." },
    status: { enum: [...STATUSES] },
    nextStep: { type: "string", maxLength: 300, description: "The next thing the owner will do." },
    nextCheck: { type: "string", maxLength: 200, description: "When to look again: a time, or an event to watch for." },
    checkAt: {
      type: "string",
      maxLength: 40,
      description:
        "When the owner is next woken to check on it, in UTC (ISO). Read from nextCheck; kept by the directory.",
    },
    checkOn: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string", minLength: 1, maxLength: 128 },
        id: { type: "string", minLength: 1, maxLength: 128 },
        where: { type: "object" },
      },
      description:
        "The record change that wakes the owner: a type, and optionally an id and fields. Read from nextCheck.",
    },
    checkedAt: { type: "string", maxLength: 40, description: "When the owner was last woken to check on it." },
    checkEvents: {
      type: "array",
      maxItems: 5,
      items: { type: "string", maxLength: 500 },
      description: "What changed since the last check, newest first, for the next one to say why it came.",
    },
    autonomy: { enum: [...AUTONOMY], description: "suggest asks first, tell acts and reports, quiet acts and logs." },
    progress: {
      type: ["object", "string"],
      required: ["value", "max"],
      properties: { value: { type: "number", minimum: 0 }, max: { type: "number", minimum: 0 } },
      maxLength: 100,
      description: "{ value, max }, or a step label.",
    },
    updates: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["at", "text"],
        properties: {
          at: { type: "string" },
          text: { type: "string", maxLength: 500 },
          by: { type: "string", maxLength: 128, description: "Who wrote it, on a room's commitment." },
        },
      },
      description: "Dated one-line entries, newest first.",
    },
    waitingOn: { type: "string", maxLength: 200, description: "Who or what it waits on, while waiting." },
    from: { type: "string", maxLength: 200, description: "Who handed it over: a person, an agent, a room." },
    room: ROOM,
  },
};

export const DOC_SCHEMA: JsonSchema = {
  type: "object",
  required: ["owner", "title"],
  properties: {
    owner: OWNER,
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", maxLength: 1_000, description: "What it covers, in a line or two." },
    body: { type: "string", maxLength: 20_000 },
    tags: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 60 } },
    reviewedAt: { type: "string", description: "When the owner last checked it was still true." },
    room: ROOM,
  },
};

export const MISS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["owner", "query"],
  properties: {
    owner: { ...OWNER, description: "The agent whose profile was closest to the search." },
    query: { type: "string", minLength: 1, maxLength: 300, description: "What was searched for." },
    askedBy: { type: "array", items: { type: "string" }, description: "The agents who searched for it that day." },
    at: { type: "string", description: "When it was first searched for that day." },
    closest: {
      type: "string",
      maxLength: 300,
      description: "The nearest commitment or doc, which wasn't close enough.",
    },
    room: ROOM,
  },
};

const SECTION_ID = { type: "string", minLength: 1, maxLength: 60 } as const;

export const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["owner"],
  properties: {
    owner: OWNER,
    note: { type: "string", maxLength: 300, description: "A sentence or two for people, in the agent's own words." },
    noteAt: { type: "string", description: "When the note was last written." },
    order: {
      type: "array",
      maxItems: 30,
      items: SECTION_ID,
      description: "Section ids, first shown first; the others follow in their usual places.",
    },
    hide: { type: "array", maxItems: 30, items: SECTION_ID, description: "Section ids the page leaves out." },
    extra: {
      type: "array",
      maxItems: MAX_EXTRA,
      items: {
        type: "object",
        required: ["id", "title", "query"],
        properties: {
          id: SECTION_ID,
          title: { type: "string", minLength: 1, maxLength: 80 },
          query: {
            type: "object",
            required: ["type"],
            properties: {
              type: { type: "string", minLength: 1, maxLength: 128 },
              where: { type: "object" },
              orderBy: { type: "string", maxLength: 128 },
              limit: { type: "number", minimum: 1, maximum: MAX_EXTRA_LIMIT },
              scopes: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      description:
        "Sections the agent added: each lists the records a state query matches, among the scopes the agent could see.",
    },
  },
};

export const UPKEEP_SCHEMA: JsonSchema = {
  type: "object",
  required: ["owner"],
  properties: {
    owner: OWNER,
    at: { type: "string", description: "When its last upkeep turn finished." },
    started: { type: "string", description: "When its latest upkeep turn started." },
    changed: {
      type: "object",
      description:
        "What its last upkeep changed, counted from the history of its records: archived, reviewed, updated, closed.",
    },
    fingerprint: { type: "string", description: "What its evidence came to after its last upkeep." },
    error: { type: "string", maxLength: 500, description: "Why its latest upkeep turn stopped, when it failed." },
    failedAt: { type: "string", description: "When its latest upkeep turn stopped, when it failed." },
    reads: {
      type: "object",
      description: "Reads of its docs by other agents, by doc id: how many, lately by whom, and when last.",
    },
    readsAtLast: { type: "object", description: "Each doc's read count when its last upkeep finished." },
  },
};

/** People edit every one of these on the State page; agents change their own only through the directory's tools. */
const PEOPLE_WRITE = { write: ["user"] };

export const DIRECTORY_TYPES: StateTypeDef[] = [
  {
    name: PROFILE_TYPE,
    description:
      "What an agent or a room is for, the work it takes on and how to ask it: one per agent under its name, one per room under room:<ref>. Agents keep their own, and their rooms', with the directory tool.",
    scope: "global",
    title: "purpose",
    schema: PROFILE_SCHEMA,
    access: PEOPLE_WRITE,
    search: { fields: ["purpose", "takesOn"] },
  },
  {
    name: COMMITMENT_TYPE,
    description:
      "Work an agent or a room has taken on: its goal, how to tell it's done, status, next step, progress and dated updates. Shared unless private; a room's live in its scope. Agents change their own, and their rooms', with the commitment tool.",
    scope: "global",
    title: "goal",
    schema: COMMITMENT_SCHEMA,
    access: PEOPLE_WRITE,
    search: { fields: ["goal", "doneWhen", "nextStep"] },
  },
  {
    name: DOC_TYPE,
    description:
      "Something an agent or a room wrote up and keeps current: how a thing works, a checklist, someone's preferences. Agents change their own, and their rooms', with the writeup tool.",
    scope: "global",
    title: "title",
    schema: DOC_SCHEMA,
    access: PEOPLE_WRITE,
    search: { fields: ["title", "summary", "tags"] },
  },
  {
    name: MISS_TYPE,
    description:
      "A directory search no commitment or doc answered, noted against the agent or room whose profile was closest so it can write what was missing. Private to that agent, or to the room's members.",
    scope: "agent",
    title: "query",
    schema: MISS_SCHEMA,
    access: PEOPLE_WRITE,
    search: { fields: ["query"] },
  },
  {
    name: PAGE_TYPE,
    description:
      "How an agent's page in the web UI is laid out, one per agent under its name: a note in its own words, the order of its sections, the ones it hides, and the ones it added. Agents keep their own with the directory tool.",
    scope: "global",
    title: "note",
    schema: PAGE_SCHEMA,
    access: PEOPLE_WRITE,
  },
  {
    name: UPKEEP_TYPE,
    description:
      "An agent's upkeep, one per agent under its name: when it last looked after what it owns and what that changed, and how often other agents read its docs. Kept by the directory, never by the agent.",
    scope: "agent",
    title: "at",
    schema: UPKEEP_SCHEMA,
    access: PEOPLE_WRITE,
  },
];

/** How close a search hit must be to count as found. Meaning and words are different measures, so each has its own. */
export interface Bar {
  meaning: number;
  words: number;
}

/**
 * Cosine similarity and word share at which a hit counts. Measured on the
 * built-in embedders' range, where related text lands well above 0.5 and
 * unrelated text below it; a deployment whose embedder scores differently sets
 * its own with the plugin's `minMeaning` and `minWords`.
 */
export const DEFAULT_BAR: Bar = { meaning: 0.5, words: 0.3 };

/**
 * A profile has to come at least this close, as a share of the bar, for a miss
 * to be put down to its agent. A profile that cleared the whole bar would
 * have been a hit, so attribution always works below it.
 */
const ATTRIBUTE_SHARE = 0.5;

/** Commitments and docs `about` reads for one agent. A full read is said as "at least". */
export const ENTRY_READ = 50;

/** Hits a search reads before keeping the ones that clear the bar, and how many of those it shows. */
const FIND_READ = 20;
export const FIND_SHOWN = 8;

/** Records read per page, and at most this many in all, when counting or listing everything. */
const PAGE = 500;
const SCAN_CAP = 5_000;

/**
 * Sessions an upkeep turn is running in now, by id. The tools' writes there
 * say `upkeep` as their surface, which is how the turn's changes are told
 * from the agent's other work when they are counted. Kept here, at module
 * level, so a reload in the middle of a turn doesn't lose it.
 */
export const UPKEEP_SESSIONS = new Set<string>();

/** A commitment's fields as a person would name them, for the update that says what a person changed. */
const FIELD_WORDS: Record<string, string> = {
  goal: "goal",
  doneWhen: "done-when",
  nextStep: "next step",
  nextCheck: "next check",
  waitingOn: "waiting-on",
  status: "status",
};

/** Changes of a room's record read to tell which fields a person's edit holds. */
const HELD_HISTORY = 500;

/** What a person sees through the UI or API: every scope. */
export const PERSON: StateCaller = { actor: { kind: "user", name: "owner" }, source: { surface: "http" } };

/** The plugin's own reads: every scope, as a person sees them, without a person's access rules. */
const READER: StateCaller = { actor: { kind: "plugin", name: "directory" }, source: { surface: "directory" } };

/**
 * Marks a caller {@link Directory.widen} gave its rooms to: its turn was
 * woken in none, so the rooms it holds are the ones it's in, not the ones it
 * was woken in. A symbol, so the copies the reads make of a caller keep it.
 */
const WIDENED = Symbol("directory.widened");
type Widened = StateCaller & { [WIDENED]?: true };

/**
 * Writes made for an agent through one of the tools. The plugin is the actor,
 * since agents can't write these types themselves; the source names the tool
 * and the agent whose doing it was, so a subscription doesn't wake an agent
 * for its own change. `surface` is the agent's own, when it had one: an
 * upkeep turn's writes say `upkeep`, which is how its changes are counted.
 */
function writer(tool: string, agent: string, surface?: string): StateCaller {
  return {
    actor: { kind: "plugin", name: "directory" },
    source: { tool, onBehalfOf: agent, ...(surface ? { surface } : {}) },
  };
}

/** The writer for a call the caller made: its tool, its name, and its surface. */
function writerFor(caller: StateCaller, tool: string): StateCaller {
  return writer(tool, caller.actor.name, caller.source?.surface);
}

/** Whether a type, as declared now, can be searched. A config type of the same name may have left `search` out. */
function searchable(service: StateService, type: string): boolean {
  return (service.getType(type)?.search?.fields?.length ?? 0) > 0;
}

export interface DirectoryOptions {
  getService: () => StateService;
  /** Every agent that exists. */
  agents: () => string[];
  /** An agent's configured description, what `about` says when it has written no profile. */
  describe: (agent: string) => string | undefined;
  /** The bar a hit must clear. Read on every search, so a reload's new values reach tools built before it. */
  bar?: () => Bar;
  /** False once the plugin is unloaded with nothing in its place. Tools built before then still answer, to say so. */
  active?: () => boolean;
  now?: () => Date;
  /** The rooms there are, read on every use. Absent, or undefined, where there are none. */
  rooms?: () => RoomSource | undefined;
  /** Which agent config says leads which room, by the room's name or ref. Read on every use, like the bar. */
  leads?: () => Record<string, string>;
  /** The runtime's time zone, which a `nextCheck` like "Friday 9am" is read in. Read on every use. */
  timeZone?: () => string;
}

/** One agent, as `about` and the HTTP route put it together. */
export interface AgentEntry {
  agent: string;
  profile: StateRecord | null;
  /** The configured description, when there is one. */
  description?: string;
  /** Open and waiting commitments the asker can see, shared ones only. */
  working: StateRecord[];
  /** The asker's own private open and waiting commitments: only when it asked about itself. */
  private: StateRecord[];
  docs: StateRecord[];
  /** Up to six misses in the agent's area in the last fortnight, newest first: only when it asked about itself. */
  misses: StateRecord[];
  /** Its page's layout: only when it asked about itself, and null when it has none. */
  page?: StateRecord | null;
  /** The live rooms it leads, by name. */
  leads: string[];
  /** Which reads came back full, so the counts above are at least what they say rather than all there is. */
  full: { commitments: boolean; docs: boolean };
}

/** One room, as `about` and the room routes put it together. */
export interface RoomEntry {
  room: RoomInfo;
  /** Its profile, or null when nobody has written one: its purpose stands in. */
  profile: StateRecord | null;
  lead: Lead;
  /** The agents in it: subscribed, and its lead. */
  members: string[];
  /** Whether the asker is in it, and so sees its commitments, docs and misses. People always are. */
  member: boolean;
  /** Why a member's turn doesn't see them: it was woken in another room. */
  away?: string;
  /** Its open and waiting commitments, its own and those its lead took on for it. */
  working: StateRecord[];
  docs: StateRecord[];
  /** Up to six misses in its area in the last fortnight, newest first. */
  misses: StateRecord[];
  full: { commitments: boolean; docs: boolean };
}

export interface Found {
  /** Hits that cleared the bar, best first, at most {@link FIND_SHOWN}. */
  hits: StateSearchHit[];
  /** How many cleared the bar among those read, and whether the read was full, so more may have. */
  cleared: number;
  /** Whether a commitment or doc cleared the bar, shown or not. A profile says whose area it is, not what they know. */
  answered: boolean;
  full: boolean;
  /** Commitments and docs that came closest without clearing the bar, best first, for a miss to name one. */
  near: StateSearchHit[];
  /**
   * The closest profile, cleared or not, when the search settled which that
   * is; null when it settled there is none. Absent when it couldn't (profiles
   * weren't searched, or other hits filled the read), so a miss looks again.
   */
  profile?: StateSearchHit | null;
  /** Types not read in full, or that can't be searched at all; a miss there may still exist. */
  partial: string[];
}

/** Reads and owner-checked writes of the directory's records. One per tool set; cheap to make. */
export class Directory {
  constructor(private readonly opts: DirectoryOptions) {}

  service(): StateService {
    return this.opts.getService();
  }

  now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** The time zone a check like "Friday 9am" is read in: the runtime's, or this machine's. */
  timeZone(): string {
    return this.opts.timeZone?.() ?? systemTimeZone();
  }

  agents(): string[] {
    return this.opts.agents();
  }

  describe(agent: string): string | undefined {
    return this.opts.describe(agent);
  }

  /** Whether the plugin that built this is still loaded, or another load took its place. */
  active(): boolean {
    return this.opts.active?.() ?? true;
  }

  /** Whether a hit is close enough to count as found. */
  clears(hit: StateSearchHit, share = 1): boolean {
    const bar = this.opts.bar?.() ?? DEFAULT_BAR;
    return hit.score >= (hit.how === "meaning" ? bar.meaning : bar.words) * share;
  }

  /**
   * The agent a name refers to: one that exists, matched without regard to
   * case, or one that has a profile. Undefined when there is neither.
   */
  async resolve(name: string): Promise<string | undefined> {
    const wanted = name.trim();
    if (!wanted) return undefined;
    const roster = this.agents();
    const exact = roster.find((a) => a === wanted) ?? roster.find((a) => a.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact;
    const profile = await this.service().get(READER, { type: PROFILE_TYPE, id: profileId(wanted) });
    // A room's profile names a room, not an agent.
    if (!profile || roomOfOwner(ownerOf(profile))) return undefined;
    return ownerOf(profile) ?? wanted;
  }

  async profile(caller: StateCaller, agent: string): Promise<StateRecord | null> {
    const record = await this.service().get(caller, { type: PROFILE_TYPE, id: profileId(agent) });
    return record && !record.archivedAt ? record : null;
  }

  /** An agent's page layout, kept under its name as its profile is. Null when it has none. */
  async page(caller: StateCaller, agent: string): Promise<StateRecord | null> {
    const record = await this.service().get(caller, { type: PAGE_TYPE, id: profileId(agent) });
    return record && !record.archivedAt ? record : null;
  }

  /** An agent's commitments the caller can see, most recently updated first. */
  async commitments(
    caller: StateCaller,
    owner: string,
    statuses: readonly Status[] = ACTIVE,
    limit = 50,
  ): Promise<StateRecord[]> {
    return this.service().query(caller, {
      type: COMMITMENT_TYPE,
      where: { owner, status: { in: [...statuses] } },
      limit,
    });
  }

  async docs(caller: StateCaller, owner: string, limit = 30): Promise<StateRecord[]> {
    return this.service().query(caller, { type: DOC_TYPE, where: { owner }, limit });
  }

  /** Misses put down to an agent since a time, newest first. Only the agent itself, and people, can see them. */
  async misses(caller: StateCaller, owner: string, since?: Date, limit = 5): Promise<StateRecord[]> {
    return this.service().query(caller, {
      type: MISS_TYPE,
      where: { owner, ...(since ? { at: { gte: since.toISOString() } } : {}) },
      limit,
    });
  }

  /** What `about` shows of one agent, read as `caller` sees it. */
  async entry(caller: StateCaller, agent: string): Promise<AgentEntry> {
    const self = caller.actor.kind === "agent" && caller.actor.name === agent;
    const own = `agent:${agent}`;
    const [profile, active, docs] = await Promise.all([
      this.profile(caller, agent),
      this.commitments(caller, agent, ACTIVE, ENTRY_READ),
      this.docs(caller, agent, ENTRY_READ),
    ]);
    const fortnight = new Date(this.now().getTime() - 14 * 86_400_000);
    const description = this.describe(agent);
    return {
      agent,
      profile,
      ...(description ? { description } : {}),
      working: active.filter((r) => r.scope !== own),
      private: self ? active.filter((r) => r.scope === own) : [],
      docs,
      misses: self ? await this.misses(caller, agent, fortnight, 6) : [],
      ...(self ? { page: await this.page(caller, agent) } : {}),
      leads: (await this.ledBy(agent)).map((r) => r.name),
      full: { commitments: active.length >= ENTRY_READ, docs: docs.length >= ENTRY_READ },
    };
  }

  // ------------------------------------------------------------------ rooms

  /** Live rooms, by name. None where there's no rooms store. */
  rooms(): RoomInfo[] {
    return this.opts.rooms?.()?.list() ?? [];
  }

  /** A room by name (a leading `#` is fine) or ref, the live one first. */
  room(nameOrRef: string): RoomInfo | undefined {
    const wanted = nameOrRef.trim().replace(/^#/, "");
    return wanted ? this.opts.rooms?.()?.find(wanted) : undefined;
  }

  /** Whose a record is, in words: the agent's name, or "the travel room" for a room's own. */
  ownerName(owner: string | undefined): string {
    const ref = roomOfOwner(owner);
    if (!ref) return owner ?? "nobody";
    return `the ${this.opts.rooms?.()?.find(ref)?.name ?? ref} room`;
  }

  /** A room's profile, or null when nobody has written one. */
  async roomProfile(room: RoomInfo): Promise<StateRecord | null> {
    const record = await this.service().get(READER, { type: PROFILE_TYPE, id: roomRecordId(room.ref) });
    return record && !record.archivedAt ? record : null;
  }

  /** Who leads a room, and where that came from. `profile`, when given, saves reading it again. */
  async lead(room: RoomInfo, profile?: StateRecord | null): Promise<Lead> {
    const p = profile === undefined ? await this.roomProfile(room) : profile;
    const chosen = typeof p?.data.lead === "string" ? p.data.lead : undefined;
    return leadOf(room, { chosen, leads: this.opts.leads?.() ?? {}, agents: this.agents() });
  }

  /** The agents in a room: those subscribed to it, and its lead, which is in it whether subscribed or not. */
  async members(room: RoomInfo, lead?: Lead): Promise<string[]> {
    const subscribed = this.opts.rooms?.()?.subscribers(room.ref) ?? [];
    const leader = (lead ?? (await this.lead(room))).agent;
    return [...new Set([...subscribed, ...(leader ? [leader] : [])])].sort();
  }

  /** The live rooms an agent is in. */
  async roomsOf(agent: string): Promise<RoomInfo[]> {
    const rooms: RoomInfo[] = [];
    for (const room of this.rooms()) if ((await this.members(room)).includes(agent)) rooms.push(room);
    return rooms;
  }

  /** The live rooms an agent leads. */
  async ledBy(agent: string): Promise<RoomInfo[]> {
    const rooms: RoomInfo[] = [];
    for (const room of this.rooms()) if ((await this.lead(room)).agent === agent) rooms.push(room);
    return rooms;
  }

  /**
   * The caller as the directory reads for it. World state shows an agent a
   * room's scope only in a turn woken in that room. A turn woken in no room,
   * its upkeep or a direct message, sees the commitments and docs of every
   * live room it's in, since that's where a lead looks after them. A turn
   * woken in a room keeps world state's rule, so another room's work stays
   * out of a conversation with agents who aren't in it. People and plugins
   * see everything already.
   */
  async widen(caller: StateCaller): Promise<StateCaller> {
    if (caller.actor.kind !== "agent" || (caller.rooms?.length ?? 0) > 0) return caller;
    const mine = (await this.roomsOf(caller.actor.name)).map((r) => r.ref);
    if (mine.length === 0) return caller;
    return { ...caller, rooms: mine, [WIDENED]: true } as Widened;
  }

  /**
   * Why a member's turn can't reach a room's records, or undefined when it
   * can: people can, and so can a turn woken in that room or in none. A turn
   * woken in another room can't, by world state's rule.
   */
  private away(caller: StateCaller, room: RoomInfo): string | undefined {
    if (caller.actor.kind !== "agent" || (caller as Widened)[WIDENED]) return undefined;
    const woken = caller.rooms ?? [];
    if (woken.length === 0 || woken.includes(room.ref)) return undefined;
    const here = woken.map((ref) => this.room(ref)?.name).find((n) => !!n);
    return `This turn is in ${here ? `the ${here} room` : "another room"}, so the ${room.name} room's records stay out of it. Work on them from the ${room.name} room itself, a direct message or your upkeep.`;
  }

  /**
   * What a caller is told about a record it can't see: that there's none,
   * or, for one of a room it's in that this turn can't reach, why. Anyone
   * else learns nothing of what a room holds.
   */
  async absent(caller: StateCaller, type: string, id: string, noun: string): Promise<string> {
    const none = `There is no ${noun} "${id}".`;
    if (caller.actor.kind !== "agent" || !caller.rooms?.length || (caller as Widened)[WIDENED]) return none;
    const hidden = await this.service().get(READER, { type, id });
    const ref = hidden?.scope.startsWith("room:") ? hidden.scope.slice("room:".length) : undefined;
    const room = ref ? this.room(ref) : undefined;
    if (!room || !(await this.members(room)).includes(caller.actor.name)) return none;
    return this.away(caller, room) ?? none;
  }

  /**
   * The live room `nameOrRef` names, when the caller may change its records:
   * people may, and agents that are in it. Refused in a sentence otherwise.
   */
  async memberOf(caller: StateCaller, nameOrRef: string): Promise<RoomInfo> {
    const room = this.room(nameOrRef);
    if (!room) {
      const known = this.rooms().map((r) => r.name);
      throw new StateError(
        `There's no room called "${nameOrRef}".${known.length ? ` Rooms: ${known.join(", ")}.` : ""}`,
      );
    }
    if (room.archived) throw new StateError(`The ${room.name} room is archived, so its records stay as they are.`);
    if (caller.actor.kind !== "agent") return room;
    const members = await this.members(room);
    if (!members.includes(caller.actor.name)) {
      throw new StateError(
        `You're not in the ${room.name} room, so you can't change its records.${members.length ? ` Its members can: ${members.join(", ")}.` : " Nobody is in it yet."}`,
      );
    }
    const away = this.away(caller, room);
    if (away) throw new StateError(away);
    return room;
  }

  /**
   * The room `nameOrRef` names, when the caller may read its commitments and
   * docs: people may, and agents in it, archived or not, from a turn woken in
   * it or in none. The caller comes back with the room's scope in its view,
   * so an archived room's records can be read too. Refused in a sentence
   * otherwise.
   */
  async readable(
    caller: StateCaller,
    nameOrRef: string,
    what: string,
  ): Promise<{ room: RoomInfo; caller: StateCaller }> {
    const room = this.room(nameOrRef);
    if (!room) {
      const known = this.rooms().map((r) => r.name);
      throw new StateError(
        `There's no room called "${nameOrRef}".${known.length ? ` Rooms: ${known.join(", ")}.` : ""}`,
      );
    }
    if (caller.actor.kind !== "agent") return { room, caller };
    if (!(await this.members(room)).includes(caller.actor.name)) {
      throw new StateError(
        `You're not in the ${room.name} room, so its ${what} aren't yours to see; its members' are. directory about with room ${room.name} says what it's for.`,
      );
    }
    const away = this.away(caller, room);
    if (away) throw new StateError(away);
    return { room, caller: { ...caller, rooms: [...new Set([...(caller.rooms ?? []), room.ref])] } };
  }

  /** A room's commitments the caller can see, its own and those its lead took on for it, newest change first. */
  async roomCommitments(
    caller: StateCaller,
    ref: string,
    statuses: readonly Status[] = ACTIVE,
    limit = 50,
  ): Promise<StateRecord[]> {
    return this.service().query(caller, {
      type: COMMITMENT_TYPE,
      where: { room: ref, status: { in: [...statuses] } },
      limit,
    });
  }

  async roomDocs(caller: StateCaller, ref: string, limit = 30): Promise<StateRecord[]> {
    return this.service().query(caller, { type: DOC_TYPE, where: { owner: roomOwner(ref) }, limit });
  }

  /** Misses put down to a room since a time, newest first. Its members and people see them. */
  async roomMisses(caller: StateCaller, ref: string, since?: Date, limit = 5): Promise<StateRecord[]> {
    return this.misses(caller, roomOwner(ref), since, limit);
  }

  /** What `about` shows of one room, read as `caller` sees it: its records only to its members. */
  async roomEntry(caller: StateCaller, room: RoomInfo): Promise<RoomEntry> {
    const profile = await this.roomProfile(room);
    const lead = await this.lead(room, profile);
    const members = await this.members(room, lead);
    const member = caller.actor.kind !== "agent" || members.includes(caller.actor.name);
    const none = { working: [], docs: [], misses: [], full: { commitments: false, docs: false } };
    if (!member) return { room, profile, lead, members, member, ...none };
    const away = this.away(caller, room);
    if (away) return { room, profile, lead, members, member, away, ...none };
    // A member reads the room's scope from a turn woken in it or in none, an archived room's too.
    const inside = caller.actor.kind === "agent" ? { ...caller, rooms: [...(caller.rooms ?? []), room.ref] } : caller;
    const fortnight = new Date(this.now().getTime() - 14 * 86_400_000);
    const [working, docs, misses] = await Promise.all([
      this.roomCommitments(inside, room.ref, ACTIVE, ENTRY_READ),
      this.roomDocs(inside, room.ref, ENTRY_READ),
      this.roomMisses(inside, room.ref, fortnight, 6),
    ]);
    return {
      room,
      profile,
      lead,
      members,
      member,
      working,
      docs,
      misses,
      full: { commitments: working.length >= ENTRY_READ, docs: docs.length >= ENTRY_READ },
    };
  }

  /**
   * The fields of a room's record that a person's edit holds, which no agent
   * may change: the room's own records, and the commitments its lead took on
   * for it, which its page shows and a person edits there alike. None for an
   * agent's other records, and none from a store that keeps no history,
   * which can't say who set what.
   */
  async held(record: StateRecord): Promise<string[]> {
    const room = typeof record.data.room === "string" && record.data.room;
    if (!roomOfOwner(ownerOf(record)) && !room) return [];
    try {
      const history = await this.service().history(
        READER,
        { type: record.type, id: record.id },
        { limit: HELD_HISTORY },
      );
      return heldFields(history, record.data);
    } catch (err) {
      if (err instanceof StateError) return [];
      throw err;
    }
  }

  /**
   * A new record of a room's, for a member: owned by the room and kept in its
   * scope, so only its members see it, under a fresh `room-<name>-<slug>` id.
   */
  async createInRoom(
    caller: StateCaller,
    tool: string,
    type: string,
    nameOrRef: string,
    title: string,
    data: Record<string, unknown>,
  ): Promise<StateRecord> {
    const room = await this.memberOf(caller, nameOrRef);
    const owned = { ...data, owner: roomOwner(room.ref), room: room.ref };
    return this.putNew(writerFor(caller, tool), type, roomOwnedId(room, title), roomOwner(room.ref), owned, title);
  }

  /**
   * Change a room's profile, for a member or a person: `change` gets its
   * fields as they stand, or, when it has none, the room's purpose to start
   * from, and returns the fields to set (`null` removes one). An agent can't
   * change a field a person holds. A person's edit to a room with no profile
   * yet is made after the directory seeds one, so the edit is what holds.
   */
  async saveRoomProfile(
    caller: StateCaller,
    nameOrRef: string,
    change: (data: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<StateRecord> {
    const room = await this.memberOf(caller, nameOrRef);
    const service = this.service();
    const ref = { type: PROFILE_TYPE, id: roomRecordId(room.ref) };
    const person = caller.actor.kind === "user";
    for (let attempt = 0; ; attempt++) {
      let existing = await service.get(READER, ref);
      try {
        // A person put it away; bringing it back is theirs too, so a member's write doesn't undo that.
        if (!person && existing?.archivedAt) {
          throw new StateError(
            `The ${room.name} room's profile is archived. A person can bring it back on the State page.`,
          );
        }
        if (person && (!existing || existing.archivedAt)) {
          existing = await service.put(
            READER,
            { ...ref, scope: "global", data: this.seed(room, existing?.archivedAt ? existing.data : {}) },
            existing?.version ?? 0,
          );
        }
        const live = existing && !existing.archivedAt ? existing : null;
        const before = live ? { ...live.data } : this.seed(room, {});
        const changes = change(before);
        if (live && !person) {
          const over = overwrites(changes, live.data, await this.held(live));
          if (over.length) throw new StateError(heldRefusal(ref.id, over));
        }
        if (live) {
          const fixed = { ...changes, owner: roomOwner(room.ref), room: room.ref };
          return await service.patch(person ? caller : writerFor(caller, "directory"), ref, fixed, live.version);
        }
        const data: Record<string, unknown> = { ...before };
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === undefined) delete data[key];
          else data[key] = value;
        }
        return await service.put(
          writerFor(caller, "directory"),
          { ...ref, scope: "global", data: { ...data, owner: roomOwner(room.ref), room: room.ref } },
          existing?.version ?? 0,
        );
      } catch (err) {
        if (!(err instanceof StateConflictError) || attempt >= 1) throw err;
      }
    }
  }

  /** A room's profile as the directory starts it: the room's purpose, over what an archived one held. */
  private seed(room: RoomInfo, from: Record<string, unknown>): Record<string, unknown> {
    return {
      ...from,
      ...(room.purpose && !from.purpose ? { purpose: room.purpose } : {}),
      owner: roomOwner(room.ref),
      room: room.ref,
    };
  }

  /**
   * A person's change to one of a room's commitments, from its page: written
   * as the person, so it holds, with a dated update saying a person made it.
   * Only a commitment of that room's, its own or one its lead took on for it.
   */
  async editRoomCommitment(room: RoomInfo, id: string, changes: Record<string, unknown>): Promise<StateRecord> {
    const service = this.service();
    const ref = { type: COMMITMENT_TYPE, id };
    for (let attempt = 0; ; attempt++) {
      const record = await service.get(PERSON, ref);
      if (!record || record.data.room !== room.ref) {
        throw new StateError(`The ${room.name} room has no commitment "${id}".`);
      }
      if (record.archivedAt) throw new StateError(`${id} is archived. Bring it back on the State page first.`);
      const said = Object.keys(changes).map((key) => {
        const name = FIELD_WORDS[key] ?? key;
        if (changes[key] === null) return `cleared the ${name}`;
        return key === "status" ? `set the status to ${changes[key]}` : `set the ${name} to "${changes[key]}"`;
      });
      const text = `A person ${said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0]}.`;
      const update = { at: this.now().toISOString(), text, by: FROM_PERSON };
      try {
        return await service.patch(
          PERSON,
          ref,
          { ...changes, updates: withUpdate(record.data.updates, update) },
          record.version,
        );
      } catch (err) {
        if (!(err instanceof StateConflictError) || attempt >= 1) throw err;
      }
    }
  }

  /**
   * Search commitments, docs and profiles as `caller` sees them, keeping the
   * hits that clear the bar. A kind a config declared without `search` can't
   * be looked through, so it counts as not read rather than as empty: the
   * search goes on without it and notes no miss.
   */
  async find(caller: StateCaller, text: string, kinds: readonly string[] = SEARCH_KINDS): Promise<Found> {
    const service = this.service();
    const types = kinds.filter((k) => searchable(service, k));
    const unsearchable = kinds.filter((k) => !types.includes(k));
    if (types.length === 0) {
      return { hits: [], cleared: 0, answered: false, full: false, near: [], partial: unsearchable };
    }
    const { hits, partial } = await service.search(caller, { text, types, limit: FIND_READ });
    const cleared = hits.filter((h) => this.clears(h));
    const full = hits.length >= FIND_READ;
    // Hits come best first, so the first profile is the closest of them all, unless the read filled up before one came.
    const first = hits.find((h) => h.record.type === PROFILE_TYPE);
    const profile = types.includes(PROFILE_TYPE) ? (first ?? (full ? undefined : null)) : undefined;
    return {
      hits: cleared.slice(0, FIND_SHOWN),
      cleared: cleared.length,
      answered: cleared.some((h) => h.record.type !== PROFILE_TYPE),
      full,
      near: hits.filter((h) => h.record.type !== PROFILE_TYPE && !this.clears(h)),
      ...(profile !== undefined ? { profile } : {}),
      partial: [...partial, ...unsearchable],
    };
  }

  /**
   * Up to two records of `type` close to `text` that belong to other agents and
   * that `caller` can see: what `open` and `write` mention so work isn't done
   * twice. Only commitments still in hand count. Never fails the write it
   * follows: a search that can't run finds nothing.
   */
  async similar(caller: StateCaller, type: string, text: string, self: string): Promise<StateSearchHit[]> {
    try {
      const { hits } = await this.service().search(caller, { text, types: [type], limit: 10 });
      return hits
        .filter((h) => {
          const owner = ownerOf(h.record);
          if (!owner || owner === self || !this.clears(h)) return false;
          return type !== COMMITMENT_TYPE || ACTIVE.includes(h.record.data.status as Status);
        })
        .slice(0, 2);
    } catch (err) {
      console.warn(`[directory] the similar-work check failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Note that a search found nothing, against the agent whose profile is
   * closest to it, so that agent can write what was missing. One miss per
   * query a day: asking again adds the asker to it. `found` is what the
   * search itself saw: the closest profile, when it settled that, saves
   * searching again, and the near hits give the miss a record to name.
   * Returns the agent it was put down to, or undefined when no profile came
   * close enough.
   */
  async miss(
    query: string,
    asker: string,
    found: Pick<Found, "near" | "profile"> = { near: [] },
  ): Promise<string | undefined> {
    const service = this.service();
    let best = found.profile;
    if (best === undefined) {
      if (!searchable(service, PROFILE_TYPE)) return undefined;
      best = (await service.search(READER, { text: query, types: [PROFILE_TYPE], limit: 1 })).hits[0] ?? null;
    }
    if (!best || !this.clears(best, ATTRIBUTE_SHARE)) return undefined;
    const owner = ownerOf(best.record) ?? best.record.id;
    // A room's miss is its members' to read, in its scope, which is the same string as its owner.
    const room = roomOfOwner(owner);
    // A room since archived, or gone, has nobody to look after its area.
    if (room && (this.room(room)?.archived ?? true)) return undefined;
    const scope = room ? roomOwner(room) : `agent:${owner}`;
    // The miss is the owner's to read, so it names only a record the owner can see too. The near hits are the
    // asker's view: its private work, or a record in a room the owner isn't in, stays out.
    const closest = found.near.find((h) => h.record.scope === "global" || h.record.scope === scope);
    const at = this.now().toISOString();
    const id = missId(query, at);
    const ref = { type: MISS_TYPE, id };
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await service.get(READER, ref);
      try {
        if (existing) {
          // A person who archived it has seen it; asking again the same day doesn't bring it back.
          if (existing.archivedAt) return ownerOf(existing);
          const askedBy = Array.isArray(existing.data.askedBy) ? (existing.data.askedBy as string[]) : [];
          if (!askedBy.includes(asker)) {
            await service.patch(writer("directory", asker), ref, { askedBy: [...askedBy, asker] }, existing.version);
          }
          return ownerOf(existing);
        }
        const data: Record<string, unknown> = { owner, query: query.slice(0, 300), askedBy: [asker], at };
        if (room) data.room = room;
        if (closest) data.closest = describeHit(closest).slice(0, 300);
        await service.put(writer("directory", asker), { type: MISS_TYPE, id, scope, data }, 0);
        return owner;
      } catch (err) {
        // Someone else noted the same miss, or added to it, a moment ago: read it again and add to that.
        if (!(err instanceof StateConflictError)) throw err;
      }
    }
    return owner;
  }

  /** Write an agent's profile, changing only the fields given. */
  async saveProfile(
    caller: StateCaller,
    fields: { purpose?: string; takesOn?: string[]; howToAsk?: string },
  ): Promise<StateRecord> {
    return this.saveOwn(caller, PROFILE_TYPE, "profile", (data) => ({ ...data, ...fields }));
  }

  /**
   * Change an agent's page layout: `change` gets its fields as they stand, or
   * none, and returns the new ones. It may throw a `StateError` to refuse.
   */
  async savePage(
    caller: StateCaller,
    change: (data: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<StateRecord> {
    return this.saveOwn(caller, PAGE_TYPE, "page", change);
  }

  /**
   * A section for the caller's page: a titled list of the records `query`
   * matches. The query is run as the caller first, so a type it can't read or
   * a `where` its own query would refuse is refused here, and the section
   * keeps the scopes the caller can see, so the page never lists more than
   * the agent could find itself. A type people can't read is refused too:
   * the page reads as a person, and would show it as an empty list.
   */
  async section(
    caller: StateCaller,
    title: string,
    query: { type: string; where?: Record<string, unknown>; orderBy?: string; limit?: number },
  ): Promise<Omit<PageSection, "id">> {
    const service = this.service();
    try {
      await service.query(caller, {
        type: query.type,
        ...(query.where ? { where: query.where as Record<string, FieldCondition> } : {}),
        ...parseOrderBy(query.orderBy),
        limit: 1,
      });
    } catch (err) {
      // The query is the agent's own: its refusal says what to fix.
      if (err instanceof StateError) throw new StateError(`That section's query doesn't run for you: ${err.message}`);
      throw err;
    }
    if (!service.listTypes(PERSON).some((t) => t.def.name === query.type)) {
      throw new StateError(`People can't read ${query.type} records, so your page couldn't show them.`);
    }
    const asked = Number.isFinite(query.limit) ? Math.floor(query.limit as number) : DEFAULT_EXTRA_LIMIT;
    const scopes = service.visibleScopes(caller);
    return {
      title,
      query: {
        type: query.type,
        ...(query.where ? { where: query.where } : {}),
        ...(query.orderBy ? { orderBy: query.orderBy } : {}),
        limit: Math.min(Math.max(1, asked), MAX_EXTRA_LIMIT),
        ...(scopes ? { scopes } : {}),
      },
    };
  }

  /**
   * A commitment a person hands an agent on its page, or a room's lead on the
   * room's: the agent's, shared, open, from a person, and written as the
   * person, so the State page and the record's history say who asked. One
   * handed to a lead names the room it's for. The person may grant it more
   * than `suggest`, which the agent can't give itself. Returns the record.
   */
  async handOver(
    agent: string,
    fields: { goal: string; doneWhen?: string; autonomy?: Autonomy },
    room?: RoomInfo,
  ): Promise<StateRecord> {
    const at = this.now().toISOString();
    const data: Record<string, unknown> = {
      owner: agent,
      goal: fields.goal,
      ...(fields.doneWhen ? { doneWhen: fields.doneWhen } : {}),
      status: "open",
      autonomy: fields.autonomy ?? AGENT_AUTONOMY,
      from: FROM_PERSON,
      ...(room ? { room: room.ref } : {}),
      updates: [
        {
          at,
          text: room
            ? `Handed over by a person on the ${room.name} room's page.`
            : "Handed over by a person on this page.",
        },
      ],
    };
    return this.putNew(PERSON, COMMITMENT_TYPE, ownedId(agent, fields.goal), "global", data, fields.goal);
  }

  /**
   * Write the caller's own record of a type that keeps one per agent under
   * its name, as profiles and pages do: `change` gets the fields as they
   * stand, or none, and returns the new ones. Refused when the record is
   * another agent's; a concurrent write is retried once against the fresh one.
   */
  private async saveOwn(
    caller: StateCaller,
    type: string,
    noun: string,
    change: (data: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<StateRecord> {
    const agent = caller.actor.name;
    const service = this.service();
    this.checkScope(caller, "global");
    const ref = { type, id: profileId(agent) };
    for (let attempt = 0; ; attempt++) {
      const existing = await service.get(READER, ref);
      const owner = existing ? ownerOf(existing) : agent;
      if (owner !== agent) throw new StateError(`The ${noun} "${ref.id}" is ${owner}'s, so you can't change it.`);
      const data = { ...change(existing && !existing.archivedAt ? { ...existing.data } : {}), owner: agent };
      try {
        return await service.put(
          writerFor(caller, "directory"),
          { type, id: ref.id, scope: "global", data },
          existing?.version ?? 0,
        );
      } catch (err) {
        if (!(err instanceof StateConflictError) || attempt >= 1) throw err;
      }
    }
  }

  /**
   * Create a record that belongs to the caller under a fresh `<owner>-<slug>`
   * id, in `scope`, which the caller must be able to see.
   */
  async create(
    caller: StateCaller,
    tool: string,
    type: string,
    title: string,
    scope: string,
    data: Record<string, unknown>,
  ): Promise<StateRecord> {
    const owner = caller.actor.name;
    this.checkScope(caller, scope);
    return this.putNew(writerFor(caller, tool), type, ownedId(owner, title), scope, { ...data, owner }, title);
  }

  /** Put a new record under `base`, or the first of `base-2` … that is free. */
  private async putNew(
    caller: StateCaller,
    type: string,
    base: string,
    scope: string,
    data: Record<string, unknown>,
    title: string,
  ): Promise<StateRecord> {
    const service = this.service();
    for (let n = 1; n <= 12; n++) {
      const id = n === 1 ? base : n <= 10 ? `${base}-${n}` : `${base}-${randomSuffix()}`;
      if (await service.get(READER, { type, id })) continue;
      try {
        return await service.put(caller, { type, id, scope, data }, 0);
      } catch (err) {
        if (!(err instanceof StateConflictError)) throw err;
      }
    }
    throw new StateError(`Couldn't find a free id for "${title}". Try a different title.`);
  }

  /**
   * One of the caller's own records, as it sees it, or one of a room's it is
   * in. A record it can't see reads as absent; one that belongs to another
   * agent is refused by name, and one of a room it isn't in by the room's.
   */
  async own(caller: StateCaller, type: string, id: string, noun: string): Promise<StateRecord> {
    const record = await this.service().get(caller, { type, id });
    if (!record) throw new StateError(await this.absent(caller, type, id, noun));
    const owner = ownerOf(record);
    const room = roomOfOwner(owner);
    if (room) {
      await this.memberOf(caller, room);
      return record;
    }
    if (owner !== caller.actor.name) {
      throw new StateError(
        owner
          ? `${id} is ${owner}'s ${noun}; only ${owner} can change it.`
          : `${id} has no owner, so no agent can change it. A person can set one on the State page.`,
      );
    }
    return record;
  }

  /**
   * Change one of the caller's records, or one of a room's it is in: `change`
   * gets the record as it stands and the fields a person's edit holds, and
   * returns the fields to set (`null` removes one). A change that would
   * overwrite a held field is refused: on a room's record, a person's edit
   * stays as they left it. A concurrent write is retried once against the
   * fresh record.
   */
  async change(
    caller: StateCaller,
    tool: string,
    type: string,
    id: string,
    noun: string,
    change: (record: StateRecord, held: string[]) => Record<string, unknown>,
  ): Promise<StateRecord> {
    for (let attempt = 0; ; attempt++) {
      const record = await this.own(caller, type, id, noun);
      if (record.archivedAt) {
        throw new StateError(`${id} is archived. A person can bring it back on the State page.`);
      }
      const held = await this.held(record);
      const changes = change(record, held);
      const over = overwrites(changes, record.data, held);
      if (over.length) throw new StateError(heldRefusal(id, over));
      try {
        return await this.service().patch(writerFor(caller, tool), { type, id }, changes, record.version);
      } catch (err) {
        if (!(err instanceof StateConflictError) || attempt >= 1) throw err;
      }
    }
  }

  /**
   * Archive one of the caller's records, or one of a room's it is in. One
   * with fields a person set is theirs to put away, unless it's a finished
   * commitment, whose fields no longer steer anything.
   */
  async archive(caller: StateCaller, tool: string, type: string, id: string, noun: string, reason?: string) {
    const record = await this.own(caller, type, id, noun);
    if (record.archivedAt) return record;
    const finished = type === COMMITMENT_TYPE && !ACTIVE.includes(String(record.data.status ?? "open") as Status);
    if (!finished) {
      const held = await this.held(record);
      if (held.length) throw new StateError(heldArchiveRefusal(id, held));
    }
    const archived = await this.service().archive(writerFor(caller, tool), { type, id }, reason, record.version);
    if (!archived) throw new StateError(`There is no ${noun} "${id}".`);
    return archived;
  }

  /**
   * Every record of a type, as a person sees them: for the HTTP routes, which
   * count and list across agents, and for upkeep. Archived ones only when asked.
   */
  async all(type: string, where?: Record<string, string>, includeArchived = false): Promise<StateRecord[]> {
    const service = this.service();
    const seen = new Map<string, StateRecord>();
    for (let offset = 0; seen.size < SCAN_CAP; offset += PAGE) {
      const page = await service.query(PERSON, {
        type,
        ...(where ? { where } : {}),
        ...(includeArchived ? { includeArchived } : {}),
        limit: PAGE,
        offset,
      });
      let fresh = 0;
      for (const record of page) {
        if (seen.has(record.id)) continue;
        seen.set(record.id, record);
        fresh++;
      }
      // A short page is the end; a page of nothing new is a store that ignores `offset`.
      if (page.length < PAGE || fresh === 0) break;
    }
    return [...seen.values()];
  }

  /** An agent's upkeep record, kept under its name in its own scope. Null when it has had none. */
  async upkeep(agent: string): Promise<StateRecord | null> {
    return this.service().get(READER, { type: UPKEEP_TYPE, id: profileId(agent) });
  }

  /**
   * Change an agent's upkeep record: `change` gets its fields as they stand,
   * or none, and returns the fields to set (`null` removes one). Written by
   * the plugin, as `caller` when given, so no agent can write it, the owner
   * least of all. A concurrent write is tried again against the fresh record.
   * One a person archived is written live again: upkeep keeps running, and a
   * record it can't write would stop every turn and every read count.
   */
  async saveUpkeep(
    agent: string,
    change: (data: Record<string, unknown>) => Record<string, unknown>,
    caller: StateCaller = READER,
  ): Promise<StateRecord> {
    const service = this.service();
    const ref = { type: UPKEEP_TYPE, id: profileId(agent) };
    for (let attempt = 0; ; attempt++) {
      const existing = await service.get(READER, ref);
      try {
        if (existing && !existing.archivedAt) {
          return await service.patch(caller, ref, change({ ...existing.data }), existing.version);
        }
        const data: Record<string, unknown> = { ...existing?.data };
        for (const [key, value] of Object.entries(change({ ...existing?.data }))) {
          if (value === null || value === undefined) delete data[key];
          else data[key] = value;
        }
        const scope = existing?.scope ?? `agent:${agent}`;
        return await service.put(caller, { ...ref, scope, data: { ...data, owner: agent } }, existing?.version ?? 0);
      } catch (err) {
        if (!(err instanceof StateConflictError) || attempt >= 2) throw err;
      }
    }
  }

  /**
   * Count a read of a doc by an agent other than its owner, in the owner's
   * upkeep record: written by the plugin for the reader, so the owner can't
   * add to it. Its own reads don't count. Never fails the read it follows.
   */
  async countRead(doc: StateRecord, reader: string): Promise<void> {
    const owner = ownerOf(doc);
    // A room's docs are read only by its members, so a read of one is nobody else's.
    if (!owner || owner === reader || roomOfOwner(owner)) return;
    try {
      await this.saveUpkeep(
        owner,
        (data) => {
          const reads = readsOf(data.reads);
          const was = reads[doc.id];
          const by = [reader, ...(was?.by ?? []).filter((a) => a !== reader)].slice(0, READERS_KEPT);
          reads[doc.id] = { n: (was?.n ?? 0) + 1, by, at: this.now().toISOString() };
          return { reads };
        },
        writer("writeup", reader),
      );
    } catch (err) {
      console.warn(`[directory] couldn't count a read of ${doc.id}: ${(err as Error).message}`);
    }
  }

  /**
   * The caller must be able to see `scope` to write there. The tools write as
   * the plugin, which sees every scope, so the agent's own view is checked
   * here instead.
   */
  private checkScope(caller: StateCaller, scope: string): void {
    const visible = this.service().visibleScopes(caller);
    if (visible && !visible.includes(scope)) throw new StateError(`You can't write to ${scope}.`);
  }
}

export function ownerOf(record: StateRecord): string | undefined {
  return typeof record.data.owner === "string" && record.data.owner ? record.data.owner : undefined;
}

/** A record id names agents and titles in letters, digits, and `_ . : -`. */
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Lowercase letters and digits joined by `-`, at most `max` long. Accents are
 * dropped, not the letters under them. A longer one is cut at the last whole
 * word that fits, so an id never ends in half a word; only a single word
 * longer than `max` is cut inside it.
 */
export function slug(text: string, max = 40): string {
  const full = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= max) return full;
  // One past the end, so a word that ends exactly at `max` is kept whole.
  const end = full.slice(0, max + 1).lastIndexOf("-");
  return (end > 0 ? full.slice(0, end) : full.slice(0, max)).replace(/-+$/, "");
}

/** A profile's or a page's id: the agent's name, or a slug of it when the name isn't a valid record id. */
export function profileId(agent: string): string {
  return RECORD_ID.test(agent) ? agent : slug(agent, 100) || "agent";
}

/** `<owner>-<slug>`, the id of a new commitment or doc. */
export function ownedId(owner: string, title: string): string {
  return `${slug(owner, 60) || "agent"}-${slug(title) || "untitled"}`;
}

/** A room's profile id: `room:<ref>`, or a slug of the ref when that isn't a valid record id. */
export function roomRecordId(ref: string): string {
  const id = `room:${ref}`;
  return RECORD_ID.test(id) ? id : `room-${slug(ref, 100) || "room"}`;
}

/** `room-<name>-<slug>`, the id of a room's new commitment or doc. */
export function roomOwnedId(room: RoomInfo, title: string): string {
  return ownedId(`room-${room.name}`, title);
}

/** A dated update in front of the old ones, keeping the newest {@link MAX_UPDATES}. */
export function withUpdate(existing: unknown, update: { at: string; text: string; by?: string }): Update[] {
  const old = Array.isArray(existing) ? (existing as Update[]) : [];
  return [{ ...update, text: update.text.slice(0, 500) }, ...old].slice(0, MAX_UPDATES);
}

/** One of a commitment's dated updates. `by` says who wrote it, on a room's. */
export interface Update {
  at: string;
  text: string;
  by?: string;
}

/**
 * One miss a query a day: the id is the day and a hash of the query's words,
 * so "Lisbon hotel prices" and "hotel prices in lisbon" are the same miss.
 */
export function missId(query: string, at: string): string {
  const words = [...new Set(wordsOf(query))].sort().join(" ") || query.trim().toLowerCase();
  const hash = createHash("sha256").update(words).digest("hex").slice(0, 12);
  return `miss-${at.slice(0, 10)}-${hash}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 7);
}

/** A hit in a few words: kind, id, title and how close it came. */
export function describeHit(hit: StateSearchHit): string {
  const r = hit.record;
  const title = titleOf(r);
  return `${r.type} ${r.id}${title ? ` "${title}"` : ""} (${hit.how} ${hit.score.toFixed(2)})`;
}

/** The field a record of the directory's types is named by. */
export function titleOf(record: StateRecord): string | undefined {
  const field = record.type === COMMITMENT_TYPE ? "goal" : record.type === MISS_TYPE ? "query" : "title";
  const value = record.data[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export type Progress = { value: number; max: number } | string;

/**
 * Progress as a model sends it: `{ value, max }`, "3/5", "3 of 5", "60%", a
 * bare number (a percentage), or a step label. Undefined for nothing.
 */
export function parseProgress(value: unknown): Progress | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return { value, max: 100 };
  if (typeof value === "object" && !Array.isArray(value)) {
    const { value: v, max } = value as Record<string, unknown>;
    const n = Number(v);
    const m = Number(max);
    if (Number.isFinite(n) && Number.isFinite(m)) return { value: n, max: m };
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
  if (percent) return { value: Number(percent[1]), max: 100 };
  const fraction = /^(\d+(?:\.\d+)?)\s*(?:\/|of|out of)\s*(\d+(?:\.\d+)?)$/i.exec(text);
  if (fraction) return { value: Number(fraction[1]), max: Number(fraction[2]) };
  return text;
}

/** "60%" for a percentage, "3/5" for a count, the label as it is. */
export function formatProgress(progress: unknown): string | undefined {
  if (typeof progress === "string") return progress.trim() || undefined;
  if (!progress || typeof progress !== "object") return undefined;
  const { value, max } = progress as Record<string, unknown>;
  if (typeof value !== "number" || typeof max !== "number") return undefined;
  return max === 100 ? `${value}%` : `${value}/${max}`;
}

/** "just now", "5 minutes ago", "2 days ago", "3 weeks ago", or the date when it's older than that. */
export function ago(iso: string | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return undefined;
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (minutes < 1) return "just now";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 14) return plural(days, "day");
  if (days < 60) return plural(Math.floor(days / 7), "week");
  return `on ${iso.slice(0, 10)}`;
}

/**
 * What a check that ended with no update to its commitment writes for it
 * (`directory-checks.ts`). It says the owner looked, not that the work moved.
 */
export const NO_CHANGE = "Checked; no change.";

/**
 * When a commitment last moved: its newest update, or the record's last
 * change. A check that changed nothing isn't a move, so work that only gets
 * looked at still reads as stalled, to its owner and to upkeep.
 */
export function lastUpdate(record: StateRecord): string {
  const updates = record.data.updates;
  const moved = Array.isArray(updates)
    ? (updates as Array<{ at?: unknown; text?: unknown } | undefined>).find((u) => u?.text !== NO_CHANGE)
    : undefined;
  return typeof moved?.at === "string" ? moved.at : record.updatedAt;
}

/** A list of strings from an array, or from one string split on commas, semicolons or new lines. */
export function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : [value];
  const items = raw.filter((v) => typeof v === "string" || typeof v === "number").map((v) => String(v).trim());
  return [...new Set(items.filter(Boolean))];
}

/** Readers kept per doc in its read count, most recent first. */
const READERS_KEPT = 5;

/** One doc's reads by other agents: how many, lately by whom, when last. */
export interface DocReads {
  n: number;
  by: string[];
  at?: string;
}

/** The read counts an upkeep record holds, by doc id, leaving out anything a hand edit made unusable. */
export function readsOf(value: unknown): Record<string, DocReads> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, DocReads> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    const r = raw as { n?: unknown; by?: unknown; at?: unknown } | null;
    if (!r || typeof r.n !== "number" || !Number.isFinite(r.n)) continue;
    out[id] = {
      n: r.n,
      by: Array.isArray(r.by) ? r.by.filter((a): a is string => typeof a === "string") : [],
      ...(typeof r.at === "string" ? { at: r.at } : {}),
    };
  }
  return out;
}
