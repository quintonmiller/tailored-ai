/**
 * The avatar the Talk page draws: a VRM model file the deployment provides.
 * Core only says where the file is; drawing and animating it happens in the
 * browser. See `docs/live-sessions.md`.
 */
import { isAbsolute } from "node:path";
import type { AgentConfig, AgentDefinition } from "../config.js";
import { taiHomePath } from "../home.js";

/** A path from the avatar's config: absolute as given, otherwise under `<TAI_HOME>/avatars/`. */
function avatarFile(path: string | undefined): string | undefined {
  const p = path?.trim();
  if (!p) return undefined;
  return isAbsolute(p) ? p : taiHomePath("avatars", p);
}

/**
 * An agent's body: its own `avatar:` over the deployment's `live.avatar`,
 * as file paths. An agent that names its own model but no animations still
 * plays the deployment's: libraries are retargeted, so any fit any model.
 * `false` is no body at all.
 */
export function resolveAvatar(
  live: AgentConfig["live"],
  own?: AgentDefinition["avatar"],
): { model?: string; animations: string[] } {
  if (own === false) return { animations: [] };
  const model = avatarFile(own?.model ?? live?.avatar?.model);
  if (!model) return { animations: [] };
  const animations = (own?.animations ?? live?.avatar?.animations ?? [])
    .map(avatarFile)
    .filter((p): p is string => !!p);
  return { model, animations };
}

/** Where the deployment's avatar model file is, or undefined when no avatar is set. */
export function avatarModelPath(live: AgentConfig["live"]): string | undefined {
  return resolveAvatar(live).model;
}

/** Where the deployment avatar's animation libraries are, in the order configured. None without a model. */
export function avatarAnimationPaths(live: AgentConfig["live"]): string[] {
  return resolveAvatar(live).animations;
}
