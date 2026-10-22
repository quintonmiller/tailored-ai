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

const OWNER = { type: "string", minLength: 1, maxLength: 128, description: "The agent this belongs to." } as const;

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
        properties: { at: { type: "string" }, text: { type: "string", maxLength: 500 } },
      },
      description: "Dated one-line entries, newest first.",
    },
    waitingOn: { type: "string", maxLength: 200, description: "Who or what it waits on, while waiting." },
    from: { type: "string", maxLength: 200, description: "Who handed it over: a person, an agent, a room." },
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
      "What an agent is for, the work it takes on and how to ask it, one per agent under its name. Agents keep their own with the directory tool.",
    scope: "global",
    title: "purpose",
    schema: PROFILE_SCHEMA,
    access: PEOPLE_WRITE,
    search: { fields: ["purpose", "takesOn"] },
  },
  {
    name: COMMITMENT_TYPE,
    description:
      "Work an agent has taken on: its goal, how to tell it's done, status, next step, progress and dated updates. Shared unless private. Agents change their own with the commitment tool.",
    scope: "global",
    title: "goal",
    schema: COMMITMENT_SCHEMA,
    access: PEOPLE_WRITE,
    search: { fields: ["goal", "doneWhen", "nextStep"] },
  },
  {
    name: DOC_TYPE,
    description:
      "Something an agent wrote up and keeps current: how a thing works, a checklist, someone's preferences. Agents change their own with the writeup tool.",
    scope: "global",
    title: "title",
    schema: DOC_SCHEMA,
    access: PEOPLE_WRITE,
    search: { fields: ["title", "summary", "tags"] },
  },
  {
    name: MISS_TYPE,
    description:
      "A directory search no commitment or doc answered, noted against the agent whose profile was closest so it can write what was missing. Private to that agent.",
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

/** What a person sees through the UI or API: every scope. */
export const PERSON: StateCaller = { actor: { kind: "user", name: "owner" }, source: { surface: "http" } };

/** The plugin's own reads: every scope, as a person sees them, without a person's access rules. */
const READER: StateCaller = { actor: { kind: "plugin", name: "directory" }, source: { surface: "directory" } };

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
  /** Which reads came back full, so the counts above are at least what they say rather than all there is. */
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
    return profile ? (ownerOf(profile) ?? wanted) : undefined;
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
      full: { commitments: active.length >= ENTRY_READ, docs: docs.length >= ENTRY_READ },
    };
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
    // The miss is the owner's to read, so it names only a record the owner can see too. The near hits are the
    // asker's view: its private work, or a record in a room the owner isn't in, stays out.
    const closest = found.near.find((h) => h.record.scope === "global" || h.record.scope === `agent:${owner}`);
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
        if (closest) data.closest = describeHit(closest).slice(0, 300);
        await service.put(writer("directory", asker), { type: MISS_TYPE, id, scope: `agent:${owner}`, data }, 0);
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
   * A commitment a person hands an agent on its page: the agent's, shared,
   * open, from a person, and written as the person, so the State page and
   * the record's history say who asked. The person may grant it more than
   * `suggest`, which the agent can't give itself. Returns the record.
   */
  async handOver(
    agent: string,
    fields: { goal: string; doneWhen?: string; autonomy?: Autonomy },
  ): Promise<StateRecord> {
    const at = this.now().toISOString();
    const data: Record<string, unknown> = {
      owner: agent,
      goal: fields.goal,
      ...(fields.doneWhen ? { doneWhen: fields.doneWhen } : {}),
      status: "open",
      autonomy: fields.autonomy ?? AGENT_AUTONOMY,
      from: FROM_PERSON,
      updates: [{ at, text: "Handed over by a person on this page." }],
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
   * One of the caller's own records, as it sees it. A record it can't see
   * reads as absent; one that belongs to another agent is refused by name.
   */
  async own(caller: StateCaller, type: string, id: string, noun: string): Promise<StateRecord> {
    const record = await this.service().get(caller, { type, id });
    if (!record) throw new StateError(`There is no ${noun} "${id}".`);
    const owner = ownerOf(record);
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
   * Change one of the caller's records: `change` gets the record as it stands
   * and returns the fields to set (`null` removes one). A concurrent write is
   * retried once against the fresh record.
   */
  async change(
    caller: StateCaller,
    tool: string,
    type: string,
    id: string,
    noun: string,
    change: (record: StateRecord) => Record<string, unknown>,
  ): Promise<StateRecord> {
    for (let attempt = 0; ; attempt++) {
      const record = await this.own(caller, type, id, noun);
      if (record.archivedAt) {
        throw new StateError(`${id} is archived. A person can bring it back on the State page.`);
      }
      try {
        return await this.service().patch(writerFor(caller, tool), { type, id }, change(record), record.version);
      } catch (err) {
        if (!(err instanceof StateConflictError) || attempt >= 1) throw err;
      }
    }
  }

  /** Archive one of the caller's records. */
  async archive(caller: StateCaller, tool: string, type: string, id: string, noun: string, reason?: string) {
    const record = await this.own(caller, type, id, noun);
    if (record.archivedAt) return record;
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
        if (existing) return await service.patch(caller, ref, change({ ...existing.data }), existing.version);
        const fields = change({});
        const data = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined));
        return await service.put(caller, { ...ref, scope: `agent:${agent}`, data: { ...data, owner: agent } }, 0);
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
    if (!owner || owner === reader) return;
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

/** When a commitment last moved: its newest update, or the record's last change. */
export function lastUpdate(record: StateRecord): string {
  const updates = record.data.updates;
  const newest = Array.isArray(updates) ? (updates[0] as { at?: unknown } | undefined) : undefined;
  return typeof newest?.at === "string" ? newest.at : record.updatedAt;
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
