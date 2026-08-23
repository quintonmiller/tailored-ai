/**
 * What the team is asked to build, as data.
 *
 * This is the reason the workshop is a simulation rather than a scenario with
 * some file tools bolted on. The descent exists because a benchmark with an
 * answer has to be re-authored every time it is beaten; a build scenario with a
 * *hardcoded brief* has a milder form of the same disease — "make a video game"
 * is one sample of one task type, and the first thing anybody wants after
 * reading the output is to try a different one. A brief is therefore a value,
 * selected with `--sim-option brief=<id>`, and adding one costs an object
 * literal rather than a scenario.
 *
 * ## Every brief declares a layout, and one arm uses it
 *
 * The reasoning was that five agents who each invent a filename in round one
 * produce five near-duplicate files nobody agreed on, so the layout is shown by
 * `list_files` from round zero with `(not created yet)` beside each row — the
 * cheapest orientation a team can be handed.
 *
 * It worked, and then it kept working: twelve consecutive runs produced a
 * byte-identical file set, and not one team ever made a file the brief had not
 * named. Orientation turned out to be the whole architecture. So `direction=open`
 * (the default) ignores `layout` entirely and the team claims files as it goes,
 * while `direction=prescribed` keeps this as the control arm. See
 * `docs/open-builds.md`.
 *
 * The layout also carries ownership, and that is kept in both arms — write access
 * is partitioned by role and read access is not, which is the one asymmetry a
 * build task can survive: hide the code from the person writing it and the
 * artifact gets worse, and the artifact is the deliverable. The open arm keeps
 * the partition and drops only the part that says which files exist.
 *
 * ## Choosing what to ask for
 *
 * Prefer a brief with an unusual constraint in it. A model that has read a
 * thousand breakout clones will produce a competent breakout clone, and that
 * says nothing at all about the framework — the polish is memorised. The
 * constraint lines below exist to push each brief slightly off the trodden path
 * without making it strange for the sake of it.
 */

export type WorkshopRole = "lead" | "builder" | "interface" | "author" | "tester";

export interface BriefFile {
  path: string;
  /** Which role may write it. Everybody may read everything. */
  owner: WorkshopRole;
  purpose: string;
}

/** A file the team is given, rather than one it writes. */
export interface BriefLibraryFile {
  /** Where it lands in the workspace, e.g. `lib/loop.js`. */
  path: string;
  /** Filename under `assets/workshop-lib/`. */
  source: string;
  /** One line, shown beside it in `list_files`. */
  purpose: string;
}

export interface Brief {
  id: string;
  /** One line, used as the run's headline. */
  title: string;
  /** What to build, in the team's own terms. Goes into every agent's instructions. */
  summary: string;
  /**
   * How the same task reads when the team is not told how to build it.
   *
   * The prescribed `summary` above describes a shape; this one describes an
   * ambition and leaves the shape to the team. Both are kept because the
   * difference between them is a measurement — see the `direction` option in
   * `index.ts`. Absent falls back to `summary`.
   */
  openSummary?: string;
  /** Hard rules. Violating one is a defect, not a style choice. */
  constraints: string[];
  /**
   * The subset of `constraints` that survives into the open arm.
   *
   * The prescribed list mixes two kinds of rule: properties of the medium (one
   * canvas, no image files) which are what make the artifact reviewable and
   * self-contained, and decisions about the game (at most one action key) which
   * are exactly the prescription being tested. Only the first kind belongs in
   * an open brief. Absent means every constraint carries over.
   */
  openConstraints?: string[];
  /** The paragraph that decides whether the run finished or merely stopped. */
  doneLooksLike: string;
  /** What a reviewer opens. Also what `check_syntax` looks for. */
  entry: string;
  layout: BriefFile[];
  /**
   * Code the team may call but not write, present from round zero.
   *
   * Absent means a from-scratch brief, which is what every entry before
   * `workshop-4` played. See {@link Brief.libraryNotes} for the summary the
   * agents actually read — nobody should have to read four files of source to
   * find out a game loop exists.
   */
  library?: BriefLibraryFile[];
  /** The API summary, injected into the brief. Kept short on purpose. */
  libraryNotes?: string;
}

/**
 * The constraints every brief inherits.
 *
 * Shared because they are properties of the *harness*, not of the task: the
 * workspace cannot reach the network, nothing here is ever executed, and the
 * artifact is reviewed by a person opening a file. A brief that restated them
 * would eventually restate one of them wrongly.
 */
export const UNIVERSAL_CONSTRAINTS = [
  "Everything must run from local files with no network access at all. No CDN links, no fonts fetched " +
    "over http, no external images. Anything you need, you write.",
  "Plain HTML, CSS and JavaScript only, apart from the provided `lib/`. No frameworks, no build step, " +
    "no package manager, no imports " +
    "between files — scripts are classic <script> tags, loaded in order, sharing globals.",
  "You have two instruments and they answer different questions. `check_syntax` parses every file and " +
    "finds unclosed tags, syntax errors and references to files that do not exist; it cannot tell you " +
    "whether the thing works. `playtest` opens the artifact in a real browser, presses keys at it, and " +
    "hands back two actual screenshots — the opening screen and a frame taken mid-play — alongside the " +
    "console errors, whether it animates and whether it responds to input. Look at the pictures. They " +
    "are the only way to tell a finished game from a black rectangle that parses, and a game that looks " +
    "empty, unreadable or unfinished on screen is one you still have work to do on. Only the tester, " +
    "the interface and the builder can call it, so if none of them runs it, nobody knows whether it works.",
];

const briefs: Brief[] = [
  {
    id: "arcade",
    title: "A small arcade game that runs in a browser",
    summary:
      "Build a single-screen arcade game playable with the keyboard. One clear goal, one clear way to " +
      "lose, a visible score, and a state you can get back from — a game over that lets you start again " +
      "without reloading the page. It should be understandable in ten seconds by somebody who has never " +
      "seen it, and still have one idea in it that is yours.",
    openSummary:
      "You are a team at a game jam. Build the best game you can in the time you have, on the theme, " +
      "playable in a browser with a keyboard. How you structure it, what files you make, who writes " +
      "what, and what kind of game it is are yours to decide. Aim for something a person will want to " +
      "play twice.",
    constraints: [
      "One <canvas>, drawn with 2D context calls. No image files and no sprite sheets — everything is " +
        "drawn from shapes, paths and text.",
      "The game must be playable with the arrow keys or WASD, plus at most one action key.",
      "No sound.",
    ],
    openConstraints: [
      "One <canvas>. No bitmap image files and no sprite sheets — everything on screen is drawn by your " +
        "code, from shapes, paths, gradients and text. You may write `.svg` files and draw them, and you " +
        "may generate textures at runtime.",
      "Playable with a keyboard.",
      "No sound.",
    ],
    doneLooksLike:
      "Somebody opens index.html, sees a title screen, presses a key, plays, loses, sees a score, and " +
      "plays again — without ever opening the console or reloading the tab.",
    entry: "index.html",
    layout: [
      { path: "index.html", owner: "interface", purpose: "The page: canvas, script tags in load order, nothing else." },
      {
        path: "design.md",
        owner: "lead",
        purpose: "What the game is, the rules, and what was decided. The team's shared memory.",
      },
      {
        path: "engine.js",
        owner: "builder",
        purpose: "The loop, input handling, state, collision, win and lose conditions.",
      },
      {
        path: "render.js",
        owner: "interface",
        purpose: "Everything drawn to the canvas. Reads state, never changes it.",
      },
      { path: "content.js", owner: "author", purpose: "Levels, tuning constants, colours, copy. Data, not behaviour." },
      { path: "style.css", owner: "interface", purpose: "Page framing around the canvas." },
      { path: "defects.md", owner: "tester", purpose: "What is broken, where, and how it was found." },
      {
        path: "submission.md",
        owner: "lead",
        purpose:
          "The jam submission: title, one-line pitch, controls, and how it uses the theme. What a judge reads first.",
      },
    ],
    library: [
      { path: "lib/loop.js", source: "loop.js", purpose: "Fixed-timestep game loop. Global: Loop" },
      { path: "lib/input.js", source: "input.js", purpose: "Keyboard state, arrows and WASD unified. Global: Keys" },
      { path: "lib/draw.js", source: "draw.js", purpose: "Canvas shapes, gradients, text, meters. Global: Draw" },
      { path: "lib/fx.js", source: "fx.js", purpose: "Particles, shake, flash, easing, seeded random. Global: FX" },
    ],
    libraryNotes: [
      /*
       * The last clause of this paragraph used to read "and a game that uses
       * none of it will lose to one that does".
       *
       * It was written to stop teams hand-rolling a fixed-timestep loop, which
       * it did. It also told every team that a game not built on `lib/` loses —
       * and a game built on Phaser uses none of `lib/`. The same brief said
       * "pick an engine" and "not using this loses", four runs running, and
       * every one of them resolved the contradiction the way the sentence
       * pointed. `use_engine none` four times, `engineChosen: 0`, and not one
       * documentation lookup.
       *
       * Third time this exact failure has been found in this file's prose: a
       * sentence written to encourage one thing, read as a rule about another.
       */
      "You can read `lib/` and call it; you cannot edit it, and you do not need to. Load the four files",
      "**before** your own scripts in index.html. Everything below is a plain global — no imports, no",
      "build step. It exists so you spend the jam on the game rather than on a game loop.",
      "",
      "  Loop.start(update, draw)     update(dt) runs at a constant 60Hz; draw() runs per frame",
      "  Loop.time, Loop.fps, Loop.stop()",
      "",
      "  Keys.down('Left')            held now. Names: Left Right Up Down Action(space) Start(enter) Pause(esc)",
      "  Keys.pressed('Action')       went down this step only — auto-repeat never counts",
      "  Keys.axisX(), Keys.axisY()   -1, 0 or 1. Both directions held reads 0",
      "  Keys.any()                   for 'press anything to start'",
      "",
      "  Draw.orb(ctx,x,y,r,colour)   a shaded sphere. The single biggest look-upgrade available to you",
      "  Draw.glow(ctx,x,y,r,colour)  soft halo; draw it before the thing",
      "  Draw.rect(ctx,x,y,w,h,radius,fill,stroke)      rounded rectangle",
      "  Draw.polygon(ctx,x,y,r,sides,rotation,fill,stroke) / Draw.star(ctx,x,y,outer,inner,points,rot,fill)",
      "  Draw.text(ctx,str,x,y,{size,weight,align,colour,shadow})",
      "  Draw.bar(ctx,x,y,w,h,value01,fill,back)        a meter: health, heat, charge, time",
      "  Draw.backdrop(ctx,w,h,topColour,bottomColour)  two-stop wash; beats a flat fill for free",
      "  Draw.lighten(c,t) / Draw.darken(c,t) / Draw.alpha(c,a)",
      "",
      "  FX.burst(x,y,{count,colour,speed,spread,life,size,gravity})   particles",
      "  FX.shake(amount)             6-10 is a hit, 20 is a death",
      "  FX.flash(colour,amount)      screen wash that fades",
      "  FX.update(dt) once per step; FX.begin(ctx) / world / FX.end(ctx) for the shake; FX.draw(ctx) after",
      "  FX.ease.outBack(t) etc, FX.lerp(a,b,t), FX.clamp(n,lo,hi)",
      "  FX.rng(seed) -> r(); r.range(lo,hi); r.int(lo,hi); r.pick(list)",
    ].join("\n"),
  },
  {
    id: "tool",
    title: "A single-page utility that does one job properly",
    summary:
      "Build a browser-based utility that takes input from a person and gives back something useful, with " +
      "no server. Pick something with real edge cases — a text diff, a cron expression explainer, a colour " +
      "palette generator with contrast checking, a duration calculator. The interesting part is not the " +
      "happy path; it is what happens on empty input, absurd input, and input that is nearly right.",
    constraints: [
      "The whole thing works offline and stores nothing outside the page.",
      "It must handle at least four named edge cases visibly and deliberately, listed in design.md.",
      "Keyboard usable throughout: no action may require a mouse.",
    ],
    doneLooksLike:
      "Somebody opens index.html, understands what it is for without instructions, uses it successfully, " +
      "then tries to break it and gets a helpful message rather than a blank screen or a console error.",
    entry: "index.html",
    layout: [
      { path: "index.html", owner: "interface", purpose: "The page structure and controls." },
      {
        path: "design.md",
        owner: "lead",
        purpose: "What it does, the edge cases it must handle, and what was decided.",
      },
      { path: "logic.js", owner: "builder", purpose: "The actual computation, independent of the DOM." },
      { path: "ui.js", owner: "interface", purpose: "Wiring the page to the logic: events, rendering, error display." },
      { path: "fixtures.js", owner: "author", purpose: "Example inputs, presets, copy, and the edge cases as data." },
      { path: "style.css", owner: "interface", purpose: "Layout and visual design." },
      { path: "defects.md", owner: "tester", purpose: "What is broken, where, and how it was found." },
      {
        path: "submission.md",
        owner: "lead",
        purpose:
          "The jam submission: title, one-line pitch, controls, and how it uses the theme. What a judge reads first.",
      },
    ],
  },
  {
    id: "site",
    title: "A small documentation site for a thing that does not exist yet",
    summary:
      "Build a two-or-three-page static site documenting a fictional but plausible command-line tool. " +
      "Invent the tool, then document it as though people already depend on it: what it does, how to " +
      "install it, a worked example, and a reference for every flag. The writing is the artifact as much " +
      "as the markup is.",
    constraints: [
      "At least two linked pages, navigable in both directions.",
      "Every flag in the reference must appear in at least one worked example, and every example must " +
        "only use flags that exist.",
      "Readable at 400px wide and at 1600px wide.",
    ],
    doneLooksLike:
      "Somebody opens index.html, understands what the tool is for within one screen, finds the reference, " +
      "and finds no example that contradicts it.",
    entry: "index.html",
    layout: [
      { path: "index.html", owner: "interface", purpose: "The landing page: what the tool is and the first example." },
      { path: "reference.html", owner: "interface", purpose: "The full flag reference." },
      {
        path: "design.md",
        owner: "lead",
        purpose: "What the tool is, its flags, and what was decided. The source of truth.",
      },
      {
        path: "content.js",
        owner: "author",
        purpose: "The flag table and examples as data, so the pages cannot drift from it.",
      },
      {
        path: "site.js",
        owner: "builder",
        purpose: "Rendering content.js into the pages, navigation, anything interactive.",
      },
      { path: "style.css", owner: "interface", purpose: "Typography and layout." },
      { path: "defects.md", owner: "tester", purpose: "Contradictions, dead links, and anything undocumented." },
      {
        path: "submission.md",
        owner: "lead",
        purpose:
          "The jam submission: title, one-line pitch, controls, and how it uses the theme. What a judge reads first.",
      },
    ],
  },
];

export const DEFAULT_BRIEF = "arcade";

export function listBriefs(): string[] {
  return briefs.map((b) => b.id);
}

export function getBrief(id: unknown): Brief {
  const wanted = String(id ?? DEFAULT_BRIEF)
    .trim()
    .toLowerCase();
  const found = briefs.find((b) => b.id === wanted);
  if (!found) {
    throw new Error(`unknown brief "${wanted}". Known: ${listBriefs().join(", ")}`);
  }
  return found;
}

/**
 * The brief as the team reads it, in the workspace and in every prompt.
 *
 * Written to `brief.md` as well as injected into instructions, and both matter
 * for different reasons: the instructions are what an agent sees on turn one,
 * and the file is what it can still read on turn two hundred after the history
 * budget has trimmed the conversation that set the whole thing up.
 *
 * Two arms, and the difference between them is the experiment. The prescribed
 * arm names eight files and their owners, which is orientation a team gets for
 * free — and, on the evidence of twelve runs that produced a byte-identical
 * file set, an architecture they will not deviate from by so much as one file.
 * The open arm says what to build and leaves the rest alone.
 */
/**
 * @param pending The library is not installed yet — it is what `use_engine
 * none` will put there. Without this the brief said "the workspace is empty"
 * in one section and listed four provided files in the next, which is the
 * kind of contradiction a reader resolves by believing whichever half suits
 * them. The API summary still belongs here either way: a team cannot weigh
 * an engine against the library without knowing what the library does.
 */
export function renderBrief(brief: Brief, direction: "open" | "prescribed" = "prescribed", pending = false): string {
  const open = direction === "open";
  const constraints = open ? (brief.openConstraints ?? brief.constraints) : brief.constraints;
  const given = brief.library?.length
    ? [
        "",
        pending ? "## What `use_engine none` would give you" : "## What you are given",
        "",
        ...brief.library.map((f) =>
          pending ? `- \`${f.path}\` — ${f.purpose}` : `- \`${f.path}\` — provided, read-only — ${f.purpose}`,
        ),
        // The full API listing is 58 lines. Before the choice it outweighed
        // every engine put together and made `none` the only legible option;
        // the compact snippet in the engine section carries the decision, and
        // this arrives once there is something to call.
        ...(brief.libraryNotes && !pending ? ["", brief.libraryNotes] : []),
        ...(pending
          ? ["", "None of this is in the workspace yet. Weigh it against the engines above and choose."]
          : open
            ? ["", "Use it or ignore it. It is there to save you time, not to tell you what to write."]
            : []),
      ]
    : [];

  if (open) {
    return [
      `# ${brief.title}`,
      "",
      brief.openSummary ?? brief.summary,
      "",
      "## Constraints",
      ...[...constraints, ...UNIVERSAL_CONSTRAINTS].map((c) => `- ${c}`),
      ...given,
      "",
      "## How you work is up to you",
      "",
      "No file layout is prescribed. Decide together what to build and how to split it, then claim the " +
        "files you are going to write with `claim_file` so two people do not write the same one. A file " +
        "belongs to whoever claimed it; everybody can read everything.",
      "",
      "Claiming reserves a name; writing makes it yours. A file you claim and do not write comes free " +
        "again after a couple of rounds, and the round announcement says when that happens — so a name " +
        "somebody reserved and then went quiet on is never lost to the team. You can also hand a file " +
        "back yourself with `release_file`, and the lead can release anybody's.",
      "",
      `The artifact is reviewed by opening \`${brief.entry}\` in a browser, so that file has to exist.`,
    ].join("\n");
  }

  return [
    `# ${brief.title}`,
    "",
    brief.summary,
    "",
    "## Constraints",
    ...[...constraints, ...UNIVERSAL_CONSTRAINTS].map((c) => `- ${c}`),
    "",
    "## Done looks like",
    "",
    brief.doneLooksLike,
    "",
    "## The files, and who writes them",
    "",
    "Everybody can read every file. Only the named role can write to one.",
    "",
    ...brief.layout.map((f) => `- \`${f.path}\` — **${f.owner}** — ${f.purpose}`),
    ...given,
    "",
    `The artifact is reviewed by opening \`${brief.entry}\` in a browser.`,
  ].join("\n");
}
