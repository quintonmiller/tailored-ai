/**
 * Discord channel config schema + parser. Core's `config.channels` is a
 * generic id-keyed map of backend-opaque option bags (no per-channel types),
 * so the Discord channel — like any plugin channel — owns its own schema and
 * parses its slice itself. This module is intentionally dependency-light (no
 * `discord.js`) so the notification paths that only need the owner id
 * (task-watcher, cron scheduler, agent-notifier, CLI) can import it without
 * pulling in the gateway client.
 */

import type { AgentConfig } from "../config.js";

/** Route a message to a project by channel id or DM origin. First match wins. */
export type DiscordProjectMapping = ({ channel: string } | { dm: true }) & { project: string };

export interface DiscordConfig {
  enabled?: boolean;
  token?: string;
  owner?: string;
  allowedGuilds?: string[];
  respondToDMs?: boolean;
  respondToMentions?: boolean;
  projectMappings?: DiscordProjectMapping[];
}

/**
 * Parse `config.channels.discord` (an opaque options bag) into the typed
 * Discord shape, or undefined when Discord isn't configured. Unknown/wrong-typed
 * fields are dropped rather than throwing — callers fall back to their defaults.
 */
export function getDiscordConfig(config: AgentConfig): DiscordConfig | undefined {
  const raw = config.channels?.discord;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return {
    enabled: asBoolean(r.enabled),
    token: asString(r.token),
    owner: asString(r.owner),
    allowedGuilds: asStringArray(r.allowedGuilds),
    respondToDMs: asBoolean(r.respondToDMs),
    respondToMentions: asBoolean(r.respondToMentions),
    projectMappings: asProjectMappings(r.projectMappings),
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

function asProjectMappings(v: unknown): DiscordProjectMapping[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: DiscordProjectMapping[] = [];
  for (const m of v) {
    if (!m || typeof m !== "object") continue;
    const e = m as Record<string, unknown>;
    if (typeof e.project !== "string") continue;
    if (typeof e.channel === "string") out.push({ channel: e.channel, project: e.project });
    else if (e.dm === true) out.push({ dm: true, project: e.project });
  }
  return out.length > 0 ? out : undefined;
}
