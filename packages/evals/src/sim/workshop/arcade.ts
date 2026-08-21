/**
 * The team's connection to the arcade: read every entry, write exactly one.
 *
 * ## Why the agents get this at all
 *
 * A jam entry that nobody can find is not an entry. The site exists so a person
 * can play what got built and score it, and the registration — title, pitch,
 * genre, what it is, how to play it — is the part only the team can write. A
 * run that finishes a good game and never says what it is produces a page that
 * reads "the team never wrote a pitch", which is a real and repeatable failure
 * worth being able to see.
 *
 * The second reason is the one that makes this an experiment rather than a
 * feature. Teams can read *previous* entries and the scores they got. A jam
 * where you can see that the last four winners all put the theme in the
 * mechanics is a different jam from one where you cannot, and whether that
 * changes anything is exactly the sort of question this package exists to ask.
 * `arcadeBrowses` and `arcadeReads` are counted so the answer is checkable
 * rather than assumed.
 *
 * ## Scoping, and why it is structural
 *
 * The write tool has no parameter for *which* entry. It closes over the one id
 * this run owns, and `ArcadeStore.register` can only reach five columns. There
 * is no argument an agent could pass to edit another team's row, which is a
 * stronger guarantee than checking one — and the reason to prefer it is that a
 * check has to be got right every time it is copied.
 *
 * ## Talking to the database, not to a server
 *
 * Deliberately not HTTP. A benchmark run that needs a web server up is a
 * benchmark run that fails for reasons belonging to neither the model nor the
 * simulation, and diagnosing "the team never registered" as a dead port is
 * exactly the kind of afternoon this package keeps having. SQLite is a file;
 * the site and the run read the same one.
 */

import {
  ArcadeStore,
  CATEGORIES,
  type Entry,
  type EntryProvenance,
  GENRES,
  publishRun,
  type ScoredEntry,
} from "@tailored-ai/arcade";
import type { Tool } from "@tailored-ai/core";
import { agentTool, optional, tool } from "../tool.js";

/** How many entries a browse returns before the history budget starts to notice. */
const BROWSE_LIMIT = 8;
const BROWSE_MAX = 20;

export interface ArcadeCounters {
  arcadeBrowses: number;
  arcadeReads: number;
  arcadeUpdates: number;
  /** 1 once the team has written anything at all about its own game. */
  arcadeRegistered: number;
}

/**
 * One run's desk at the arcade.
 *
 * Constructed with the store already open, so a failure to open it is handled
 * once — at the top — rather than by every tool discovering it separately.
 */
export class ArcadeDesk {
  readonly counts: ArcadeCounters = {
    arcadeBrowses: 0,
    arcadeReads: 0,
    arcadeUpdates: 0,
    arcadeRegistered: 0,
  };

  private readonly store: ArcadeStore;
  private readonly entryId: string;
  /** Roles allowed to write the registration. Undefined means everybody. */
  private readonly registrarRoles: string[] | undefined;

  constructor(store: ArcadeStore, provenance: EntryProvenance, registrarRoles?: string[]) {
    this.store = store;
    this.entryId = store.createEntry(provenance).id;
    this.registrarRoles = registrarRoles;
  }

  get id(): string {
    return this.entryId;
  }

  /** What the team has written about itself, for the announcement line. */
  get registered(): boolean {
    return this.store.entry(this.entryId)?.registered ?? false;
  }

  /**
   * Freeze the entry and put it on the site.
   *
   * Called from the simulation's `finalise()`, which is the only place that
   * knows the run is genuinely over. A run with no files is not published: a
   * three-round smoke test leaves the same directory shape as a real jam and a
   * board full of empty pages is worse than a shorter board.
   */
  publish(artifactPath: string, metrics: Record<string, number>, hasFiles: boolean): void {
    if (!hasFiles) return;
    publishRun(this.store, this.entryId, { artifactPath, metrics });
  }

  tools(): Tool[] {
    return [this.browseTool(), this.readTool(), this.entryTool(), this.registerTool()];
  }

  // ------------------------------------------------------------------ tools

  private browseTool(): Tool {
    return optional(
      tool(
        "arcade_browse",
        "List games other teams submitted to the arcade in previous jams, with the scores a human judge gave them.",
        {
          sort: `overall, recent, or a category: ${CATEGORIES.map((c) => c.key).join(", ")}. Optional; defaults to overall.`,
          limit: `How many to list. Optional; defaults to ${BROWSE_LIMIT}, maximum ${BROWSE_MAX}.`,
        },
        (args) => {
          this.counts.arcadeBrowses += 1;
          return this.renderBoard(String(args.sort ?? "overall"), Number(args.limit ?? BROWSE_LIMIT));
        },
        "read",
      ),
      "sort",
      "limit",
    );
  }

  private readTool(): Tool {
    return tool(
      "arcade_read",
      "Read one game's arcade page in full: its pitch, what it is, how to play it, its scores and what reviewers said.",
      { slug: "The game's slug, as shown by arcade_browse." },
      (args) => {
        this.counts.arcadeReads += 1;
        const slug = String(args.slug ?? "").trim();
        const entry = this.store.entryBySlug(slug);
        if (!entry) throw new Error(`no game called "${slug}" on the arcade. arcade_browse lists the slugs.`);
        return this.renderEntry(this.store.scored(entry.id) as ScoredEntry, true);
      },
      "read",
    );
  }

  private entryTool(): Tool {
    return tool(
      "arcade_entry",
      "Read your own team's arcade entry as it currently stands, and what is still missing from it.",
      {},
      () => {
        this.counts.arcadeReads += 1;
        return this.renderOwn();
      },
      "read",
    );
  }

  private registerTool(): Tool {
    return optional(
      agentTool(
        "arcade_register",
        "Register your team's game on the arcade, or update your registration. This is the page a judge reads " +
          "before playing. Only writes your own entry; pass just the fields you want to change.",
        {
          title: "The game's name. Optional if you are only changing something else.",
          tagline: "One line, under 15 words, the way a jam page pitches a game. Optional.",
          description: "What it is and how the theme shaped it. A judge reads this first. Optional.",
          instructions: "How to play: the controls, the goal, how you lose. Optional.",
          genre: `What kind of game it is. One of: ${GENRES.join(", ")}. Optional.`,
        },
        (args, agent) => {
          if (this.registrarRoles && !this.registrarRoles.includes(String(agent ?? ""))) {
            throw new Error(
              `only ${this.registrarRoles.join(" or ")} registers the team's entry on the arcade. Say what you want on the page instead.`,
            );
          }
          const fields = {
            title: str(args.title),
            tagline: str(args.tagline),
            description: str(args.description),
            instructions: str(args.instructions),
            genre: str(args.genre),
          };
          if (Object.values(fields).every((value) => value === undefined)) {
            throw new Error(
              "nothing to register — pass at least one of title, tagline, description, instructions, genre.",
            );
          }
          this.store.register(this.entryId, fields);
          this.counts.arcadeUpdates += 1;
          this.counts.arcadeRegistered = 1;
          return this.renderOwn("Registered.");
        },
      ),
      "title",
      "tagline",
      "description",
      "instructions",
      "genre",
    );
  }

  // -------------------------------------------------------------- rendering

  private renderBoard(sort: string, limit: number): string {
    const wanted = Number.isFinite(limit) ? Math.max(1, Math.min(BROWSE_MAX, Math.floor(limit))) : BROWSE_LIMIT;
    const total = this.store.count();
    // Never list the entry being written right now. It is a draft and invisible
    // to `list()` anyway; saying so out loud stops a team reading the absence as
    // a failure and calling this four more times.
    if (total === 0) {
      return "The arcade has no published games yet. Yours would be the first — there is nothing to compare against.";
    }

    const entries = this.store.list({ sort, limit: wanted });
    const lines = [
      `The arcade has ${total} published game${total === 1 ? "" : "s"}. Sorted by ${sort}, showing ${entries.length}.`,
      "(Your own entry is not here: it goes up when this jam ends.)",
      "",
    ];
    for (const entry of entries) {
      lines.push(...this.summarise(entry));
    }
    lines.push("Read any of them in full with arcade_read, using the name at the start of the line.");
    return lines.join("\n");
  }

  private summarise(entry: ScoredEntry): string[] {
    const head =
      entry.overall === null
        ? `${entry.slug} — not yet judged`
        : `${entry.slug} — ${entry.overall.toFixed(2)} overall from ${entry.reviewCount} review${entry.reviewCount === 1 ? "" : "s"}`;
    const facts = [entry.theme, entry.genre, `${entry.rounds} rounds`].filter(Boolean).join(" · ");
    const out = [head, `  ${entry.tagline ? `"${entry.tagline}" · ` : ""}${facts}`];
    const scored = CATEGORIES.filter((c) => entry.scores[c.key]);
    if (scored.length) {
      out.push(`  ${scored.map((c) => `${c.key} ${entry.scores[c.key].mean.toFixed(1)}`).join("  ")}`);
    }
    out.push("");
    return out;
  }

  private renderEntry(entry: ScoredEntry, withReviews: boolean): string {
    const lines = [
      `${entry.title ?? entry.slug} (${entry.slug})`,
      entry.overall === null
        ? "Not yet judged."
        : `${entry.overall.toFixed(2)} overall from ${entry.reviewCount} review${entry.reviewCount === 1 ? "" : "s"}.`,
      [entry.theme && `Theme ${entry.theme}`, entry.genre, `${entry.rounds} rounds`, entry.model]
        .filter(Boolean)
        .join(" · "),
      "",
    ];
    if (entry.tagline) lines.push(`Pitch: ${entry.tagline}`, "");
    if (entry.description) lines.push("About:", entry.description, "");
    if (entry.instructions) lines.push("How to play:", entry.instructions, "");

    const scored = CATEGORIES.filter((c) => entry.scores[c.key]);
    if (scored.length) {
      lines.push("Scores:");
      for (const category of scored) {
        lines.push(
          `  ${category.name.padEnd(18)} ${entry.scores[category.key].mean.toFixed(1)}  — ${category.question}`,
        );
      }
      lines.push("");
    }

    if (withReviews) {
      const notes = this.store.reviews(entry.id).filter((review) => review.notes.trim());
      if (notes.length) {
        lines.push("What the judge said:");
        for (const review of notes) lines.push(`  ${review.reviewer}: ${review.notes}`);
        lines.push("");
      }
    }
    return lines.join("\n").trimEnd();
  }

  /**
   * The team's own page, and what is missing from it.
   *
   * Saying what is *absent* is the load-bearing half. A team reading back what
   * it already wrote learns nothing; a team told "instructions: empty — a judge
   * will not know which keys do anything" has a next action.
   */
  private renderOwn(prefix?: string): string {
    const entry = this.store.entry(this.entryId) as Entry;
    const rows: [string, string | undefined, string][] = [
      ["Title", entry.title, "the name at the top of your page"],
      ["Pitch", entry.tagline, "one line, the way a jam page sells a game"],
      ["Genre", entry.genre, `one of: ${GENRES.join(", ")}`],
      ["About", entry.description, "what it is and how the theme shaped it — a judge reads this first"],
      ["How to play", entry.instructions, "the controls, the goal, how you lose"],
    ];

    const lines = [prefix ?? "Your team's arcade entry. It goes on the site when the jam ends.", ""];
    for (const [label, value, why] of rows) {
      lines.push(value ? `  ${label.padEnd(12)} ${oneLine(value)}` : `  ${label.padEnd(12)} — empty (${why})`);
    }

    const missing = rows.filter(([, value]) => !value).map(([label]) => label.toLowerCase());
    lines.push("");
    lines.push(
      missing.length === 0
        ? "Everything a judge needs is filled in. arcade_register again to change any of it."
        : `Still empty: ${missing.join(", ")}. Fill them with arcade_register before the jam ends.`,
    );
    return lines.join("\n");
  }
}

/** Trim a long field down to something a tool result can carry. */
function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

/** An argument the model did not pass, told apart from one it passed empty. */
function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

/**
 * Open the arcade, or return nothing and let the run continue without it.
 *
 * The arcade is a side effect of a jam, not a precondition for one. A read-only
 * home directory, a locked database or a missing native binding should cost the
 * team its submission page, not its whole run — and a benchmark that fails for
 * a reason belonging to neither the model nor the simulation is worse than one
 * that quietly notes the loss.
 */
export function openArcade(home: string | undefined): ArcadeStore | undefined {
  try {
    return new ArcadeStore(home);
  } catch {
    return undefined;
  }
}
