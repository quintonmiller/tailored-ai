/**
 * The avatar the Talk page draws: a VRM model file the deployment provides.
 * Core only says where the file is; drawing and animating it happens in the
 * browser. See `docs/live-sessions.md`.
 */
import { readdirSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
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

/** A model a body can be drawn in, by the name it is chosen by: its file's name. */
export interface AvatarModel {
  name: string;
  path: string;
}

/** What a model file may be: a VRM, the format the page draws. */
const MODEL_FILE = /\.vrm$/i;

/**
 * Every model the deployment has to choose from: each one the config names,
 * the deployment's and each agent's own (`own`), wherever it is, and every
 * VRM file in `<TAI_HOME>/avatars/`. Each is known by its file's name, and of
 * two with the same name the first counts, configured ones first. A folder
 * that can't be read has none in it.
 */
export function avatarModels(live: AgentConfig["live"], own: AgentDefinition["avatar"][] = []): AvatarModel[] {
  const configured = [resolveAvatar(live).model, ...own.map((o) => (o === false ? undefined : avatarFile(o?.model)))];
  let inFolder: string[] = [];
  try {
    inFolder = readdirSync(taiHomePath("avatars"), { withFileTypes: true })
      .filter((e) => e.isFile() && MODEL_FILE.test(e.name))
      .map((e) => taiHomePath("avatars", e.name))
      .sort();
  } catch {
    // No avatars folder: only what the config names.
  }
  const out: AvatarModel[] = [];
  for (const path of [...configured, ...inFolder]) {
    if (!path) continue;
    const name = basename(path);
    if (!out.some((m) => m.name === name)) out.push({ name, path });
  }
  return out;
}

/** The model a name stands for, among those the deployment has; undefined for any other name. */
export function avatarModelNamed(models: AvatarModel[], name: string | undefined): AvatarModel | undefined {
  const wanted = name?.trim().toLowerCase();
  if (!wanted) return undefined;
  return (
    models.find((m) => m.name.toLowerCase() === wanted) ??
    models.find((m) => m.name.toLowerCase().replace(MODEL_FILE, "") === wanted.replace(MODEL_FILE, ""))
  );
}
