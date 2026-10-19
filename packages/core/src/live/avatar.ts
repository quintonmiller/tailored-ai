/**
 * The avatar the Talk page draws: a VRM model file the deployment provides.
 * Core only says where the file is; drawing and animating it happens in the
 * browser. See `docs/live-sessions.md`.
 */
import { isAbsolute } from "node:path";
import type { AgentConfig } from "../config.js";
import { taiHomePath } from "../home.js";

/** A path from the avatar's config: absolute as given, otherwise under `<TAI_HOME>/avatars/`. */
function avatarFile(path: string | undefined): string | undefined {
  const p = path?.trim();
  if (!p) return undefined;
  return isAbsolute(p) ? p : taiHomePath("avatars", p);
}

/** Where the configured avatar's model file is, or undefined when no avatar is set. */
export function avatarModelPath(live: AgentConfig["live"]): string | undefined {
  return avatarFile(live?.avatar?.model);
}

/** Where the avatar's animation libraries are, in the order configured. None without a model to play them on. */
export function avatarAnimationPaths(live: AgentConfig["live"]): string[] {
  if (!avatarModelPath(live)) return [];
  return (live?.avatar?.animations ?? []).map(avatarFile).filter((p): p is string => !!p);
}
