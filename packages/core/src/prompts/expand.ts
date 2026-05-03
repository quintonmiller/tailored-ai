import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface ExpandOptions {
  /** Directory used to resolve {{include:relative/path}} references. Defaults to process.cwd(). */
  baseDir?: string;
  /** Allow !`cmd` shell expansion. Off by default since it executes arbitrary commands at render time. */
  allowShellExpansion?: boolean;
  /** Timeout per shell expansion. Default 5000ms. */
  shellTimeoutMs?: number;
  /** Max nested {{include:...}} depth. Default 5. */
  maxIncludeDepth?: number;
}

const DEFAULTS: Required<Omit<ExpandOptions, "baseDir">> & { baseDir: string } = {
  baseDir: process.cwd(),
  allowShellExpansion: false,
  shellTimeoutMs: 5000,
  maxIncludeDepth: 5,
};

/** Replace all {{key}} placeholders with values from vars. Sync; covers the legacy applyTemplates surface. */
export function applyVars(text: string, vars: Record<string, string>): string {
  if (!text.includes("{{")) return text;
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * Expand a prompt template. Supports, in this order:
 *   1. {{include:path}} — file inclusion (depth-limited; included content is expanded recursively)
 *   2. {{var}}          — variable substitution from `vars`
 *   3. !`shell cmd`     — inline shell expansion (gated by allowShellExpansion)
 *
 * On shell error, injects `[!shell error: ...]` so the agent sees the failure rather than silently empty output.
 */
export async function expandPrompt(
  text: string,
  vars: Record<string, string> = {},
  options: ExpandOptions = {},
): Promise<string> {
  const opts = { ...DEFAULTS, ...options };
  const withIncludes = await expandIncludes(text, opts.baseDir, opts, 0);
  const withVars = applyVars(withIncludes, vars);
  if (!opts.allowShellExpansion) return withVars;
  return expandShell(withVars, opts.shellTimeoutMs);
}

async function expandIncludes(
  text: string,
  baseDir: string,
  opts: Required<Omit<ExpandOptions, "baseDir">> & { baseDir: string },
  depth: number,
): Promise<string> {
  if (!text.includes("{{include:")) return text;
  if (depth >= opts.maxIncludeDepth) {
    return text.replace(
      /\{\{include:[^}]+\}\}/g,
      (m) => `[include error: max depth ${opts.maxIncludeDepth} exceeded at ${m}]`,
    );
  }

  const matches = [...text.matchAll(/\{\{include:([^}]+)\}\}/g)];
  if (matches.length === 0) return text;

  const replacements = await Promise.all(
    matches.map(async (m) => {
      const rawPath = m[1].trim();
      const fullPath = isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath);
      try {
        const content = await fs.readFile(fullPath, "utf8");
        return expandIncludes(content, dirname(fullPath), opts, depth + 1);
      } catch (err) {
        return `[include error: ${(err as Error).message}]`;
      }
    }),
  );

  let i = 0;
  return text.replace(/\{\{include:[^}]+\}\}/g, () => replacements[i++]);
}

async function expandShell(text: string, timeoutMs: number): Promise<string> {
  if (!text.includes("!`")) return text;
  const matches = [...text.matchAll(/!`([^`]+)`/g)];
  if (matches.length === 0) return text;

  const outputs = await Promise.all(matches.map((m) => runShell(m[1].trim(), timeoutMs)));
  let i = 0;
  return text.replace(/!`[^`]+`/g, () => outputs[i++]);
}

function runShell(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolveOut) => {
    execFile(
      "bash",
      ["-c", command],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr.trim() || err.message;
          resolveOut(`[!shell error: ${msg}]`);
          return;
        }
        resolveOut(stdout.trimEnd());
      },
    );
  });
}
