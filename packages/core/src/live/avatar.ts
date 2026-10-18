/**
 * The avatar the Talk page draws: a VRM model file the deployment provides.
 * Core only says where the file is; drawing and animating it happens in the
 * browser. See `docs/live-sessions.md`.
 */
import { isAbsolute } from "node:path";
import type { AgentConfig } from "../config.js";
import { taiHomePath } from "../home.js";

/** Where the configured avatar's model file is, or undefined when no avatar is set. */
export function avatarModelPath(live: AgentConfig["live"]): string | undefined {
  const model = live?.avatar?.model?.trim();
  if (!model) return undefined;
  return isAbsolute(model) ? model : taiHomePath("avatars", model);
}
