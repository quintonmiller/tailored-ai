import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ResourceManifest } from "./interface.js";
import { ManifestError } from "./manifest.js";

/**
 * agentskills.io SKILL.md support.
 *
 * The spec: a skill is a directory containing a `SKILL.md` file with YAML
 * frontmatter and a Markdown body. The body is the skill's instructions; the
 * frontmatter carries identity, discovery metadata, compatibility, and the
 * tool allowlist.
 *
 * Required frontmatter:
 *   name         — must match the parent directory name (regex below)
 *   description  — short blurb about purpose + when to invoke
 *
 * Optional:
 *   license, compatibility, metadata, allowed-tools (or allowedTools), version
 *
 * The Markdown body becomes the skill's instructions. This module produces a
 * native {@link ResourceManifest} so the rest of the resource pipeline (loader,
 * registries, lockfile) keeps working unchanged.
 */

/** Frontmatter name + dir-name regex per the agentskills.io spec. */
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/;

const SKILL_MD_FILENAMES = ["SKILL.md", "Skill.md", "skill.md"];

export interface ParseSkillMdOptions {
  /** Used for `name` regex enforcement against the parent directory basename. */
  dirName?: string;
  /** Path being read — for error messages. */
  source?: string;
}

export interface SkillMdParseResult {
  manifest: ResourceManifest;
  /** Raw Markdown body (the skill's instructions). */
  body: string;
  /** Trimmed frontmatter object as authored. */
  frontmatter: Record<string, unknown>;
}

/** Find a SKILL.md file in a directory; returns absolute path or null. */
export function findSkillMdFile(rootPath: string): string | null {
  for (const name of SKILL_MD_FILENAMES) {
    const candidate = join(rootPath, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Convenience: read a SKILL.md from disk and parse it. */
export async function readSkillMd(filePath: string): Promise<SkillMdParseResult> {
  const text = await readFile(filePath, "utf8");
  const parentDir = basename(filePath.replace(/[\\/]SKILL\.md$/i, ""));
  return parseSkillMd(text, { dirName: parentDir, source: filePath });
}

/**
 * Parse a SKILL.md text blob into a ResourceManifest + Markdown body.
 *
 * The returned manifest's `data` block contains both the instructions (body)
 * and the agentskills.io fields, so downstream code that already reads
 * `manifest.data` (e.g. `parseSkillData`) continues to work.
 */
export function parseSkillMd(text: string, opts: ParseSkillMdOptions = {}): SkillMdParseResult {
  const { frontmatter: fmText, body } = splitFrontmatter(text, opts.source);
  const frontmatter = fmText ? coerceFrontmatter(parseYaml(fmText), opts.source) : {};

  const name = frontmatter.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new ManifestError("SKILL.md frontmatter must include a non-empty `name`", opts.source);
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new ManifestError(
      `SKILL.md \`name\` must match ${SKILL_NAME_PATTERN} (lowercase, hyphens, optional one-level org/) — got ${JSON.stringify(name)}`,
      opts.source,
    );
  }
  if (opts.dirName != null && opts.dirName.length > 0) {
    // The spec requires the dir basename to equal `name`. For an org-prefixed
    // name like `my-org/foo`, the basename equals the last segment (`foo`).
    const lastSegment = name.includes("/") ? (name.split("/").pop() as string) : name;
    if (opts.dirName !== name && opts.dirName !== lastSegment) {
      throw new ManifestError(
        `SKILL.md \`name\` (${name}) does not match the parent directory (${opts.dirName})`,
        opts.source,
      );
    }
  }

  const description = frontmatter.description;
  if (typeof description !== "string" || description.length === 0) {
    throw new ManifestError("SKILL.md frontmatter must include a non-empty `description`", opts.source);
  }

  const version = typeof frontmatter.version === "string" ? frontmatter.version : "0.0.0";

  const allowedTools = pickStringArray(frontmatter, ["allowed-tools", "allowedTools"], opts.source);

  const instructions = body.trim();

  const data: Record<string, unknown> = {
    instructions,
  };
  if (allowedTools && allowedTools.length > 0) data.toolRefs = allowedTools;
  if (frontmatter.license != null) data.license = frontmatter.license;
  if (frontmatter.compatibility != null) data.compatibility = frontmatter.compatibility;
  if (frontmatter.metadata != null) data.metadata = frontmatter.metadata;

  const manifest: ResourceManifest = {
    kind: "skill",
    id: name,
    version,
    description,
    data,
  };

  return { manifest, body: instructions, frontmatter };
}

/**
 * Split a SKILL.md text into its `---` frontmatter and body. Empty frontmatter
 * is allowed (it'll fail validation downstream for missing `name`).
 */
function splitFrontmatter(text: string, source?: string): { frontmatter: string; body: string } {
  // Tolerate a BOM and any leading whitespace.
  const cleaned = text.replace(/^﻿/, "");
  const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = fmRegex.exec(cleaned);
  if (!match) {
    throw new ManifestError("SKILL.md must start with a `---` frontmatter block", source);
  }
  return { frontmatter: match[1], body: match[2] ?? "" };
}

function coerceFrontmatter(raw: unknown, source?: string): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestError("SKILL.md frontmatter must be a YAML object", source);
  }
  return raw as Record<string, unknown>;
}

function pickStringArray(
  obj: Record<string, unknown>,
  keys: readonly string[],
  source: string | undefined,
): string[] | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (v == null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      throw new ManifestError(`SKILL.md \`${key}\` must be an array of strings`, source);
    }
    return v as string[];
  }
  return undefined;
}

/** Render a parsed skill back to SKILL.md text. Used by authoring/storage. */
export function renderSkillMd(input: {
  name: string;
  description: string;
  body: string;
  version?: string;
  license?: unknown;
  compatibility?: unknown;
  metadata?: unknown;
  allowedTools?: string[];
}): string {
  if (!SKILL_NAME_PATTERN.test(input.name)) {
    throw new ManifestError(`skill name must match ${SKILL_NAME_PATTERN} — got ${JSON.stringify(input.name)}`);
  }
  const fm: Record<string, unknown> = {
    name: input.name,
    description: input.description,
  };
  if (input.version && input.version !== "0.0.0") fm.version = input.version;
  if (input.license != null) fm.license = input.license;
  if (input.compatibility != null) fm.compatibility = input.compatibility;
  if (input.metadata != null) fm.metadata = input.metadata;
  if (input.allowedTools && input.allowedTools.length > 0) fm["allowed-tools"] = input.allowedTools;

  // Hand-roll the YAML so key order is stable and human-friendly.
  const lines: string[] = ["---"];
  lines.push(`name: ${yamlScalar(input.name)}`);
  lines.push(`description: ${yamlScalar(input.description)}`);
  for (const k of Object.keys(fm)) {
    if (k === "name" || k === "description") continue;
    const v = fm[k];
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
    } else if (v != null && typeof v === "object") {
      lines.push(`${k}:`);
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        lines.push(`  ${kk}: ${yamlScalar(vv)}`);
      }
    } else if (v != null) {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---", "", input.body.trim(), "");
  return lines.join("\n");
}

function yamlScalar(v: unknown): string {
  if (typeof v === "string") {
    if (/^[A-Za-z0-9._/\- ]+$/.test(v) && !v.startsWith(" ") && !v.endsWith(" ")) return v;
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

/** Predicate used by FileResourceSource to choose SKILL.md over manifest.yaml. */
export function isSkillMdPath(p: string): boolean {
  return /[\\/]SKILL\.md$/i.test(p);
}
