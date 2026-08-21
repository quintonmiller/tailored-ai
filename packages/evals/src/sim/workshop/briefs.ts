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
 * ## Every brief declares its own file layout
 *
 * Not decoration, and not the simulation's business to decide. Five agents who
 * each invent a filename in round one produce five near-duplicate files nobody
 * agreed on, and the artifact becomes a directory you cannot review. The layout
 * is shown by `list_files` from round zero with `(not created yet)` beside each
 * row, which is the cheapest orientation a team can be handed.
 *
 * It also carries ownership. Write access is partitioned by role and read
 * access is not, which is the one asymmetry a build task can survive: hide the
 * code from the person writing it and the artifact gets worse, and the artifact
 * is the deliverable.
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
  /** Hard rules. Violating one is a defect, not a style choice. */
  constraints: string[];
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
    constraints: [
      "One <canvas>, drawn with 2D context calls. No image files and no sprite sheets — everything is " +
        "drawn from shapes, paths and text.",
      "The game must be playable with the arrow keys or WASD, plus at most one action key.",
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
      "`lib/` is already in the workspace. You can read it and call it; you cannot edit it, and you do not",
      "need to. Load the four files **before** your own scripts in index.html. Everything below is a plain",
      "global — no imports, no build step. This exists so you spend the jam on the game rather than on a",
      "game loop, and a game that uses none of it will lose to one that does.",
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
 */
export function renderBrief(brief: Brief): string {
  const lines = [
    `# ${brief.title}`,
    "",
    brief.summary,
    "",
    "## Constraints",
    ...[...brief.constraints, ...UNIVERSAL_CONSTRAINTS].map((c) => `- ${c}`),
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
    ...(brief.library?.length
      ? [
          "",
          "## What you are given",
          "",
          ...brief.library.map((f) => `- \`${f.path}\` — provided, read-only — ${f.purpose}`),
          ...(brief.libraryNotes ? ["", brief.libraryNotes] : []),
        ]
      : []),
    "",
    `The artifact is reviewed by opening \`${brief.entry}\` in a browser.`,
  ];
  return lines.join("\n");
}
