/**
 * The arcade: where the game jam's output goes to be looked at.
 *
 * A local site plus the database behind it. Two very different clients read the
 * same rows — a person with a browser who plays the games and scores them, and
 * the next run's agents, who get a tool that queries this store directly rather
 * than over HTTP. The second is why `ArcadeStore` is exported at all: an eval
 * run must not depend on a server being up, and a simulation that had to poll a
 * port would fail in a way that looked like the model's fault.
 *
 * Nothing here imports from `@tailored-ai/core`, and nothing should. The site
 * is not part of the framework; it is a thing the benchmark writes to.
 */

export {
  CATEGORIES,
  CATEGORY_KEYS,
  type Category,
  CLAIM_KEYS,
  CLAIMS,
  type Claim,
  cleanScore,
  GATE_KEYS,
  GATES,
  type Gate,
  GENRES,
  type Genre,
  normaliseGenre,
  overallScore,
  RUBRIC_VERSION,
  round2,
  SCORE_MAX,
  SCORE_MIN,
} from "./categories.js";
export { type PublishResult, publishRun, snapshotVersion } from "./publish.js";
export { type ArcadeServer, createArcadeServer, listen, type ServeOptions } from "./server.js";
export {
  ACTIVITY_BODY_MAX,
  ACTIVITY_KEEP,
  type ActivityInput,
  type ActivityRow,
  ARCADE_SCHEMA_VERSION,
  ArcadeStore,
  arcadeHome,
  type CategoryScore,
  type Entry,
  type EntryProvenance,
  LIVE_SHOT,
  type ListQuery,
  REGISTRATION_FIELDS,
  type Registration,
  type Review,
  type ScoredEntry,
  slugify,
  sortEntries,
  type Version,
  type VersionInput,
} from "./store.js";
export { crc32, type ZipFile, zip } from "./zip.js";
