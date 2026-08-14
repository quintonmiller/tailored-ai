# The Endless Descent — improvement roadmap

Updated 2026-08-13. This is the implementation roadmap for the next iterations
of the benchmark. The original investigation and design review remain in
[endless-descent-improvements.md](./endless-descent-improvements.md); this file
reflects the current floor-one, maze-enabled implementation.

## Goals

The benchmark should produce runs that are meaningfully different, require
coordinated decisions with visible consequences, and remain understandable to
someone watching without access to the agents' private context.

The main success criteria are:

1. Preparation, routing, combat, equipment, and progression all offer choices
   without a single universally correct answer.
2. Seeded runs differ in layout, threats, rewards, and viable builds while
   remaining exactly reproducible.
3. The broadcast makes current state, recent events, party builds, and progress
   against comparable past runs clear at a glance.
4. Baseline policies retain a useful gradient, with better coordination and
   memory producing measurably better results.

## Current foundation

The following work is complete on `feat/endless-descent-overhaul`:

- The pre-overhaul tree is preserved at commit `eb57db2` on
  `backup/endless-descent-pre-overhaul-20260813`.
- Simulation state, narration, traces, and broadcast animations agree on the
  resolved tick; repeated combat animations and several accounting defects are
  fixed.
- Runs begin at a surface outfitter above floor one with limited seeded stock,
  individual gold, empty packs, and two skill points per character.
- Every class has a three-branch, three-rank talent tree and earns another point
  when the party levels.
- Maze-enabled floors contain 5–7 persistent rooms with branches, loops,
  backtracking, encounters, elites, caches, merchants, shrines, stairs, and
  boss gates.
- Retreat abandons readied actions, grants enemies an opportunity attack, and
  adds dread. Surviving enemies, health, statuses, boss phase, and deferred
  room rewards persist if the party takes another route and returns later.
- Maze encounters vary enemy count, health, and damage by seed. Layouts, stock,
  drops, and routes are also seeded and reproducible.
- Ordinary rooms have independently seeded persistent environments: floods,
  spores, arcane wells, narrow bridges, and raised galleries. Their effects
  alter combat, mana, elemental choices, or retreat risk and remain unchanged
  on re-entry.
- Every floor adds a one-way loop, a concealed shortcut, a locked optional
  loop, a recoverable floor key, and a concealed route trap without
  compromising the guaranteed traversable room tree. The party can spend the
  key, have the rogue pick the lock, have the guardian breach it, or ignore the
  shortcut; the rogue can also scout hidden routes and spend dread to disarm a
  chosen trap.
- The broadcast shows the explored room graph, current room and zone, equipped
  items, invested talents, unspent points, readied actions, and synchronized
  combat results.
- Inventory, equipment, stock, caches, and drops use stable per-copy item
  instances. Seeded rarity and positive/negative stat affixes make copies of
  the same base item differ while preserving base ids as compatibility aliases.
- Rare procedural affixes can change rules through cleave, vampirism, passive
  combat regeneration, map revelation, merchant negotiation, cache capacity,
  and cooldown reduction.
- The broadcast highlights the character who most recently spoke or acted and
  shows their full stats, equipment, pack, item affixes, talents, cooldowns,
  statuses, gold, skill points, and readied action.
- The current 60-seed, 40-round baseline means are: random 101, basic tactics
  214, tactics-only 594, greedy damage 579, rule-based 643, and oracle 671.

## Prioritized improvements

### P0 — Procedural equipment and item identity

This remains the highest-value game-system track. Stable varied copies are now
in place; the next value comes from modifiers and effects that alter tactics,
exploration, and party allocation rather than only core stats.

Planned work:

- Replace inventory strings with stable item instances containing a unique id,
  base item id, rarity, affixes, description, and provenance.
- Generate zero or more positive and negative affixes from seeded, slot-aware
  pools.
- Support multiple modifiers on one item: power, armour, health, mana, speed,
  experience gain, luck, resistance, healing, critical chance, and cooldown
  changes.
- Add effects that change play rather than only numbers:
  - area damage or cleave;
  - vampirism;
  - passive regeneration;
  - reveal adjacent rooms;
  - reveal more of the floor graph;
  - merchant discounts or improved sell prices;
  - extra cache capacity;
  - conditional shields, counters, or status application.
- Add drawbacks such as reduced speed, maximum health, healing received,
  elemental vulnerability, or increased dread generation.
- Make affixes available consistently through starting stock, merchants,
  caches, ordinary drops, elites, and bosses.
- Preserve deterministic generation and retain the base item id for tool calls,
  narration, diagnostics, and migration of old traces.

Acceptance criteria:

- Two copies of the same base item can create different build decisions.
- A higher-rarity item is not automatically better for every character.
- The rule-based policy can evaluate simple upgrades; the oracle can evaluate
  conditional effects; random remains legal but clearly weaker.
- Full item details appear in `look` and the broadcast without overwhelming the
  always-visible party strip.

Progress as of 2026-08-13:

- Complete: stable instance ids, base ids, rarity, descriptions, provenance,
  and seeded, slot-aware affix rolls.
- Complete: positive and negative modifiers for power, armour, health, mana,
  and speed affect recomputed fighter stats.
- Complete: every generated source materialises instances consistently, and a
  dedicated item RNG keeps affix changes from perturbing encounter or route
  selection.
- Complete: detailed item data is available in `look` and the typed broadcast
  scene contract; callers use exact instance ids to distinguish copies, while a
  legacy base id deterministically selects a matching copy.
- Complete: initial play-changing affixes support cleave, vampirism, passive
  regeneration, adjacent or full-floor revelation, merchant discounts and
  improved sales, extra cache capacity, and cooldown reduction.
- Complete: policies account for class fit, numeric modifiers, and the first
  set of rule-changing effects when buying, assigning, and equipping gear.
- Remaining: XP, luck, resistance, healing, and critical modifiers;
  conditional shields, counters, and status effects; more effect-specific
  policy reasoning; and final balance sweeps.

### P0 — Broadcast inventory and active-character detail

The party strip and active-character detail are now in place. The remaining
work is visual categorisation and event explanation: making every object and
every zero-damage or state-changing result unmistakable.

Planned work:

- Show small, consistent slot/status/skill icons beneath every character.
- Add a full active-character panel containing stats, equipment, inventory,
  item modifiers, talents, cooldowns, gold, and readied action.
- Clearly distinguish characters, enemies, loot, consumables, room features,
  and effects so an object can never visually appear to attack.
- Add persistent enemy nameplates and health-change feedback.
- Show why an action dealt zero damage: immunity, resistance, armour, shield,
  miss, invalid target, or stale action.
- Show retreat intent, opportunity attacks, path movement, room entry, loot
  assignment, equipping, leveling, and talent investment as explicit events.
- Keep rendering keyed to authoritative tick/event ids so snapshots cannot
  replay an animation.

Acceptance criteria:

- A viewer can identify every combatant and interactable object without relying
  on its silhouette.
- A viewer can explain the last round and the current pending decision within a
  few seconds.
- Item, actor, and enemy identifiers are validated at the simulation/broadcast
  boundary.

Progress as of 2026-08-13:

- Complete: the active-character panel follows the most recent speaker or tool
  caller and exposes full build and item detail without crowding all five party
  cards.
- Complete: cooldowns and full item-instance data cross the typed scene
  contract, while the compact party strip remains synchronized with it.
- Complete: escaped encounters remain marked on the floor graph with enemy
  count, combined current/maximum health, and retreat count; path hints and
  scout reports describe the same authoritative state.
- Remaining: compact slot/status/skill iconography under every character;
  stronger actor/interactable visual categories; persistent enemy nameplates;
  zero-damage reasons; and dedicated movement, retreat, loot, equipment, and
  level-up event treatments.

### P1 — Stronger visual zones and room identity

The simulation now names zones, but the stage should make them visually
distinct.

Planned work:

- Give every zone its own palette, lighting, floor/wall materials, particles,
  ambient motion, props, and room silhouettes.
- Give room types recognizable staging: merchant camp, shrine, cache, elite
  arena, boss gate, stairs, flooded room, narrow bridge, and open hall.
- Tie generated room labels and map nodes to the same visual theme data used by
  the stage.
- Use transitions to show movement between connected rooms and descent between
  floors.
- Vary encounter composition and staging by room geometry without changing the
  underlying deterministic rules.

Acceptance criteria:

- A viewer can recognize the current zone and common room type without reading
  the text label.
- Visual variation never changes or obscures the authoritative game state.

### P1 — More consequential exploration

The room graph creates navigation choices, but most edges currently differ only
by the room at the other end.

Planned work:

- Add locked doors, keys, one-way drops, shortcuts, traps, secret rooms, and
  destructible or class-specific routes.
- Add partial information: sounds, tracks, light, architecture, and scout
  reports should hint at risk without revealing exact contents.
- Add room hazards and benefits that persist across combat rounds.
- Let the party leave the stairs and continue exploring for optional rewards,
  at rising dread and resource risk.
- Preserve retreat from ordinary encounters while assigning consequences based
  on room geometry or enemy speed.
- Persist escaped enemies and their health if the party later returns, rather
  than regenerating the encounter.
- Add explicit metrics for rooms explored, rooms skipped, backtracking,
  shortcuts, retreats, and optional objectives completed.

Acceptance criteria:

- At least two reasonable routes regularly exist, with different expected
  risks and rewards.
- Exploration cannot be solved by always taking the same room-kind priority.
- Retreat is useful in some states but is not a free encounter reroll.

Progress as of 2026-08-13:

- Complete: encounters are owned by rooms. Retreating and exploring elsewhere
  preserves the exact surviving enemy objects, health, statuses, age, boss
  phase, and already-earned room rewards until that room is cleared or the
  floor is left.
- Complete: partial rewards are isolated by room, fixing the bug where gold
  from an abandoned fight could be paid out by clearing a different encounter.
- Complete: occupied rooms remain visible in `look`, path hints, rogue scout
  reports, the typed scene contract, and the broadcast map. Baseline policies
  recognize wounded encounters as finishable work when the party is healthy.
- Complete: metrics now count rooms skipped on descent, backtracking,
  retreats, encounter re-engagements, and optional rooms completed in addition
  to rooms explored.
- Complete: typed routes support one-way drops, rogue-discovered secret
  shortcuts, and seeded blade, poison-dart, or mana-ward traps. Scouting
  identifies adjacent route features; disarming trades dread for safety; an
  undisarmed trap changes party state only on its first crossing.
- Complete: route kinds and directions appear in path choices and the
  broadcast floor graph, while metrics count traps triggered/disarmed, secrets
  found/taken, and one-way drops used. Rule-based policies scout situationally,
  disarm only a route they intend to use, and take shortcuts only when the
  destination justifies their information cost.
- Complete: every floor has an optional locked loop and one deterministic key
  earned by clearing a room. A key opens the route freely, the rogue can pick
  it for one dread, and the guardian can breach it for physical damage and two
  dread. Closed routes refuse movement explicitly and can never gate the
  stairs; opening method, key location/state, and five lock/key metrics cross
  narration, policy state, the scene contract, and the broadcast map.
- Complete: every ordinary room has one of five persistent, independently
  seeded environments. Floods amplify lightning and suppress fire, spores
  damage both sides each round, arcane wells restore caster mana, and raised
  galleries empower mage and ranger attacks. Path hints, `look`, narration,
  policies, seven metrics, the typed scene, map icons, tooltips, and the active
  map palette all use the same authoritative room state.
- Complete: retreating across a narrow bridge lets the fastest enemy catch the
  slowest party member for another reduced attack when its speed is higher,
  adding dread and explicit narration. The same geometry remains if the party
  returns to the persistent encounter.
- Remaining: secret rooms beyond shortcuts, additional destructible or
  class-specific routes, and a broader environment/geometry catalogue.

### P1 — Comparable past-run context

The broadcast has history and record infrastructure, but comparisons should be
configuration-aware and more explanatory.

Planned work:

- Compare only runs with compatible scenario fingerprints, horizon, start
  mode, and material simulation options.
- Show current XP, floor, rooms explored, bosses, deaths, and elapsed rounds
  against the median, best, and previous comparable run.
- Add a ghost progress line by round and markers for important events.
- Show deltas such as “one floor ahead,” “two rooms behind,” or “boss reached
  four rounds earlier,” not only raw totals.
- Show the current run's position among baseline policies and historical agent
  runs.
- Make seed/configuration differences visible so an easier seed is not presented
  as an organisational improvement.

Acceptance criteria:

- Every comparison names the cohort it uses.
- Incompatible historical runs are excluded or clearly labelled.
- The viewer can tell whether a lead came from pace, combat success, optional
  exploration, or survival.

### P2 — Deeper class progression

The first talent trees create build choices but currently modify core stats.

Planned work:

- Add mutually exclusive talent branches and rank prerequisites.
- Add active abilities and passive rule changes, not only stat bonuses.
- Give each class at least one exploration talent and one party-support talent.
- Add limited respec opportunities with a meaningful cost.
- Offer level-up choices at predictable breakpoints and make unspent points
  conspicuous in both tools and broadcast.
- Teach baseline policies enough about builds to preserve the ladder without
  giving non-oracle policies hidden information.

Potential examples:

- Guardian: intercept opportunity attacks or hold a doorway.
- Mage: reveal elemental hazards or chain a spell under a condition.
- Rogue: expose secret edges or make retreat safer.
- Cleric: convert overhealing into a temporary shield.
- Ranger: reveal encounter composition or improve path clues.

### P2 — More encounter and event variety

Planned work:

- Add mixed-family encounter templates with explicit tactical interactions.
- Add minibosses, rare variants, environmental hazards, and multi-stage bosses.
- Add non-combat events with tradeoffs involving health, gold, equipment,
  talents, dread, map information, or party separation.
- Add wandering enemies that move through the room graph.
- Add optional floor objectives and rewards so “find stairs immediately” and
  “clear everything” are both situational strategies.
- Expand loot tables and shop behaviour by zone and depth.

### P2 — Narration and information hierarchy

Planned work:

- Narrate decisions and consequences, not every repeated attack.
- Collapse repeated low-information actions into summaries.
- Use stable terminology shared by tools, narration, event feed, and stage.
- Give important discoveries, build changes, retreats, deaths, revives, boss
  phases, and record changes dedicated callouts.
- Ensure narration always reads resolved state and cites the correct round.

## Correctness and benchmark safeguards

Every tranche should include:

- deterministic same-seed/same-decisions tests;
- different-seed variation tests;
- trace ordering and broadcast deduplication tests;
- scene-contract validation between simulation and browser;
- illegal-phase, invalid-target, and self-transfer tests;
- baseline sweeps at the scenario's real options and horizon;
- milestone reachability checks;
- explicit configuration fingerprints for historical comparisons;
- performance checks for long baseline sweeps and repeated browser snapshots.

No feature should be accepted solely because it looks interesting in one run.
It must either create a measurable decision, make the broadcast clearer, or
increase controlled variation without degrading reproducibility.

## Suggested implementation sequence

1. **Complete:** introduce item instances and foundational affix generation
   behind compatibility helpers.
2. **Complete:** add detailed item/build data to the scene contract and the
   active-character broadcast panel.
3. **Complete:** add the first unique item effects and teach baseline policies
   how to value the simple subset.
4. **In progress:** escaped encounters, room-owned rewards, threat visibility,
   exploration metrics, one-way drops, traps, and secret shortcuts are
   complete; add locks, keys, destructible routes, and persistent room hazards
   next.
5. Implement zone-specific stage themes and room staging.
6. Add historical ghost comparisons with strict cohort matching.
7. Expand talents into active/passive rule changes.
8. Add events, minibosses, hazards, and optional floor objectives.
9. Re-run large baseline sweeps, recalibrate milestones, and update benchmark
   documentation and committed comparison cohorts.

## Deferred ideas

- Splitting the five characters into separate communication rooms remains a
  possible scenario variant, not a default change. It would confound dungeon
  play with cross-room message routing in the current benchmark.
- Permanent meta-progression between benchmark runs is out of scope because it
  would make runs incomparable. All progression should begin and end within one
  seeded run.
- Unseeded randomness is out of scope. Variation must remain reproducible for
  debugging, grading, narration, and broadcast replay.
