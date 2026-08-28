/**
 * The compiler's copy of a promise made in two places.
 *
 * Nothing imports this and nothing runs it. It exists so that `tsc` — which
 * compiles every file under `src/` — is forced to compare the scene the
 * simulation builds against the scene the broadcast reads. The assignments
 * below emit no JavaScript; they fail the build, which is the only thing they
 * are for.
 *
 * Kept out of `__tests__` deliberately: that directory is excluded from
 * `tsconfig.json`, so a type-level assertion written there would typecheck
 * nothing at all and read as a guarantee while providing none.
 */

import type { Scene, SceneBeat, ScenePartyMember } from "../../broadcast-contract.js";
import type { DescentScene } from "./index.js";

/**
 * Both directions, on purpose.
 *
 * One direction alone would let the server quietly grow a field the page never
 * learns about, or the page invent one the server never sends. Requiring both
 * makes the two declarations the same shape rather than merely compatible.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const sceneMatches: Exact<DescentScene, Scene> = true;
const partyMatches: Exact<DescentScene["party"][number], ScenePartyMember> = true;
const beatsMatch: Exact<DescentScene["beats"][number], SceneBeat> = true;

export const SCENE_CONTRACT_CHECKED = sceneMatches && partyMatches && beatsMatch;
