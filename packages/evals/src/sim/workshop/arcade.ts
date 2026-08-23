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

import { readFileSync } from "node:fs";
import {
  type ActivityInput,
  ArcadeStore,
  CATEGORIES,
  type Entry,
  type EntryProvenance,
  GENRES,
  publishRun,
  type ScoredEntry,
  snapshotVersion,
} from "@tailored-ai/arcade";
import type { Tool } from "@tailored-ai/core";
import { agentTool, optional, tool } from "../tool.js";

/** How many entries a browse returns before the history budget starts to notice. */
const BROWSE_LIMIT = 8;
const BROWSE_MAX = 20;

/** Buffered activity rows that trigger a write before the round ends. */
const FLUSH_AT = 12;

/*
 * How much of somebody else's page a tool result may carry.
 *
 * The store lets a team write 8,000 characters of description and 4,000 of
 * instructions, which is right — a jam page should not be clipped for a person
 * reading it in a browser. Handing all of it back through a tool is a different
 * question: one `arcade_read` at those limits is roughly three thousand tokens
 * in a single result, in a run whose history budget is the binding constraint
 * on whether the team still remembers its own plan at round eighteen.
 *
 * So the page keeps everything and the tool result is trimmed, with the cut
 * marked. A team that needs more than this from a competitor's pitch is not
 * short of information.
 */
const READ_DESCRIPTION = 1200;
const READ_INSTRUCTIONS = 700;
const READ_NOTES = 500;

export interface ArcadeCounters {
  arcadeBrowses: number;
  arcadeReads: number;
  arcadeUpdates: number;
  /** 1 once the team has written anything at all about its own game. */
  arcadeRegistered: number;
  /**
   * Builds put on the board during the jam.
   *
   * The number to read next to `roundsWithNoWrite`: a team that submits once at
   * the end is the old behaviour wearing a new tool, and a team that submits
   * five times has actually stopped treating the horizon as a cliff.
   */
  arcadeSubmits: number;
  /**
   * Builds the harness checkpointed after a clean playtest, nobody having asked.
   *
   * Kept apart from `arcadeSubmits` so "did the team choose to ship" survives
   * the existence of a safety net. A run whose only builds are automatic is a
   * run where the mechanism did not land.
   */
  arcadeAutoSubmits: number;
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
    arcadeSubmits: 0,
    arcadeAutoSubmits: 0,
  };

  private readonly store: ArcadeStore;
  private readonly entryId: string;
  /** Unwritten activity. See {@link ArcadeDesk.note}. */
  private readonly pending: ActivityInput[] = [];
  /** Roles allowed to write the registration. Undefined means everybody. */
  private readonly registrarRoles: string[] | undefined;
  /** The run's own directory, which is where a build gets copied from. */
  private readonly artifactPath: string;
  /** Where the jam is up to, asked at submit time so it is never stale. */
  private readonly now: () => { round: number; metrics: Record<string, number> };

  constructor(
    store: ArcadeStore,
    provenance: EntryProvenance,
    registrarRoles?: string[],
    now: () => { round: number; metrics: Record<string, number> } = () => ({ round: 0, metrics: {} }),
  ) {
    this.store = store;
    this.entryId = store.createEntry(provenance).id;
    this.registrarRoles = registrarRoles;
    this.artifactPath = provenance.artifactPath;
    this.now = now;
  }

  /** Builds this team has put on the board, newest first. */
  get submitted(): { version: string; round: number | null }[] {
    return this.store.versions(this.entryId).map((v) => ({ version: v.version, round: v.round }));
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
    // Before the early return: a run that wrote nothing still said things, and
    // the feed is the only record of that which outlives the worktree.
    this.flush();
    if (!hasFiles) return;
    publishRun(this.store, this.entryId, { artifactPath, metrics });
  }

  /**
   * Say the run is still alive, and how far it has got.
   *
   * Called once a round. Two things go over: the counter bag, which is the same
   * shape a finished entry carries so the site renders both with one renderer,
   * and the newest playtest frame, so the live panel shows the game as it is
   * rather than a progress bar over an unknown.
   *
   * Swallows everything. A jam must not die because the board it reports to is
   * unwritable — the artifact on disk is the deliverable and the page is a
   * convenience.
   */
  heartbeat(metrics: Record<string, number>, shot?: string): void {
    try {
      this.store.progress(this.entryId, { metrics });
      if (shot) this.store.liveShot(this.entryId, readFileSync(shot));
    } catch {
      // Nothing to say: a missed heartbeat costs a stale panel for one round.
    }
    this.flush();
  }

  /**
   * Note something the team said or did, for the live feed.
   *
   * Buffered rather than written straight through. Posts arrive one at a time,
   * several per turn, and a synchronous SQLite write per message would put the
   * arcade in the critical path of every agent turn for the sake of a page
   * nobody may have open. The buffer is drained on the round heartbeat and
   * whenever it gets long enough to be worth a transaction.
   */
  note(row: ActivityInput): void {
    this.pending.push(row);
    if (this.pending.length >= FLUSH_AT) this.flush();
  }

  /** Write the buffer. Called on the heartbeat, and once more at publish. */
  flush(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    try {
      this.store.addActivity(this.entryId, batch);
    } catch {
      // A dropped batch costs a gap in a live feed and nothing else.
    }
  }

  tools(): Tool[] {
    return [this.browseTool(), this.readTool(), this.entryTool(), this.registerTool(), this.submitTool()];
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
          this.note({
            kind: "did",
            ...(agent ? { agent } : {}),
            room: "arcade",
            body: `registered the game${fields.title ? ` as ${fields.title}` : ""}`,
          });
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

  /**
   * Putting the current build on the board, mid-jam, as many times as they like.
   *
   * The tool exists to remove a bad incentive rather than to add a capability.
   * With one publish at the horizon the safe play was to stop building early
   * and spend the last third of the jam proving the game still worked — which
   * is exactly what teams did, and why the write curve collapsed two-thirds of
   * the way through every run. A team that can ship what it has and carry on
   * has no reason to freeze.
   *
   * Says out loud that the last submitted build is the judged one, because that
   * is the rule which makes submitting early rational rather than merely
   * permitted.
   */
  private submitTool(): Tool {
    return optional(
      agentTool(
        "submit_version",
        "Put the game as it stands right now on the arcade as a numbered build, and keep working. " +
          "The most recent build you submit is the one that gets judged, so submit as soon as it is " +
          "playable and again whenever it gets better.",
        {
          version: "What to call this build, like 0.2.0 or 1.0. Optional; defaults to the next number.",
          notes: "What changed since the last build, in one or two lines. Optional.",
        },
        (args, agent) => {
          if (this.registrarRoles && !this.registrarRoles.includes(String(agent ?? ""))) {
            throw new Error(
              `only ${this.registrarRoles.join(" or ")} submits the team's build. Say it is ready instead.`,
            );
          }
          const { round, metrics } = this.now();
          const version = str(args.version) ?? this.nextVersion();
          const notes = str(args.notes) ?? "";
          let built: number;
          try {
            built = snapshotVersion(this.store, this.entryId, {
              artifactPath: this.artifactPath,
              version,
              notes,
              round,
              metrics,
            }).files;
          } catch (err) {
            // The tool's own refusals are worth reading; anything else is an
            // arcade problem and must not read as the team's mistake.
            throw new Error(String((err as Error).message ?? err));
          }
          this.counts.arcadeSubmits += 1;
          this.note({
            kind: "did",
            ...(agent ? { agent } : {}),
            room: "arcade",
            body: `submitted build ${version}${notes ? ` — ${notes}` : ""}`,
          });
          const history = this.submitted;
          return (
            `Submitted ${version} — ${built} file${built === 1 ? "" : "s"}, playable on the arcade now. ` +
            `This is the build that gets judged unless you submit a newer one. ` +
            (history.length > 1 ? `Builds so far: ${history.map((h) => h.version).join(", ")}.` : "Your first build.")
          );
        },
      ),
      "version",
      "notes",
    );
  }

  /** `0.1.0`, `0.2.0`, … for a team that did not name its build. */
  private nextVersion(): string {
    return `0.${this.store.versions(this.entryId).length + 1}.0`;
  }

  /**
   * The harness putting a working build on the board, unasked.
   *
   * Called after a clean playtest. See `WorkshopSimulation.checkpoint` for why
   * this exists rather than the tool simply being handed to more roles.
   *
   * Marked `auto` on the row so a page can distinguish "the team shipped this"
   * from "nobody stopped us losing this", and so `arcadeSubmits` keeps meaning
   * what it meant before the backstop existed.
   */
  autoSubmit(round: number, metricsEdits: number): void {
    snapshotVersion(this.store, this.entryId, {
      artifactPath: this.artifactPath,
      version: this.nextVersion(),
      notes: "automatic checkpoint — the game ran clean and there was new work since the last build",
      round,
      metrics: { edits: metricsEdits },
      auto: true,
    });
    this.counts.arcadeAutoSubmits += 1;
    this.note({
      kind: "did",
      room: "arcade",
      body: "checkpointed a working build (automatic)",
    });
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
    if (entry.description) lines.push("About:", clip(entry.description, READ_DESCRIPTION), "");
    if (entry.instructions) lines.push("How to play:", clip(entry.instructions, READ_INSTRUCTIONS), "");

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
        for (const review of notes) lines.push(`  ${review.reviewer}: ${clip(review.notes, READ_NOTES)}`);
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

/**
 * Trim a field for a tool result, and say so.
 *
 * Marked rather than silent: a model handed a sentence that stops mid-clause
 * with no explanation will reasonably treat it as the whole sentence, and the
 * cheapest defence against that is four words.
 */
function clip(value: string, limit: number): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}… [trimmed; the full text is on the site]`;
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
