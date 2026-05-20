import { resolve } from "node:path";
import type { ToolContext } from "./interface.js";

/**
 * If `context.workingDirectoryBoundary` is set, ensure `fullPath` resolves
 * inside it. Returns null when ok, or a structured error otherwise.
 *
 * Used by `read`, `write`, and `exec` so coder/reviewer dispatches that
 * have a worktree boundary can't escape it via absolute paths. The bug
 * this guards against: model issues `write(path="/abs/path/outside/worktree",
 * …)` — without the boundary the write goes through and pollutes whatever
 * checkout the absolute path points at.
 */
export function checkSandboxBoundary(
  fullPath: string,
  context: ToolContext,
): { ok: true } | { ok: false; error: string } {
  const boundary = context.workingDirectoryBoundary;
  if (!boundary) return { ok: true };
  const root = resolve(boundary);
  const target = resolve(fullPath);
  if (target === root) return { ok: true };
  if (target.startsWith(root + "/")) return { ok: true };
  return {
    ok: false,
    error:
      `Path "${target}" is outside the sandbox root (${root}). ` +
      `This agent's tool calls must stay within its worktree. Use relative ` +
      `paths or absolute paths under ${root}.`,
  };
}

/**
 * Best-effort exec-command guard. When a sandbox boundary is set, scans
 * the command for absolute-path tokens that point INTO the parent repo
 * (where the worktree lives) but OUTSIDE the worktree itself — the
 * exact escape shape we saw the coder use ("git -C /home/.../main-checkout").
 * We intentionally allow absolute paths into unrelated parts of the
 * filesystem (/etc, /usr, /tmp, /dev, the user's repos folder, etc.)
 * because the coder needs to grep /usr/include / look at /etc/hostname
 * / write to /tmp — that's not the escape we're guarding against here.
 *
 * Returns null when ok, or a structured error otherwise. The check is
 * a heuristic, not a security boundary — process-level isolation
 * (worker / WASM sandboxes) is the real fix for untrusted code.
 */
export function checkExecBoundary(
  command: string,
  context: ToolContext,
): { ok: true } | { ok: false; error: string } {
  const boundary = context.workingDirectoryBoundary;
  if (!boundary) return { ok: true };
  const root = resolve(boundary);
  // The boundary path is typically <repoRoot>/.worktrees/agent/<slug>.
  // Anything under <repoRoot> that ISN'T under <root> is a parent-repo
  // escape, which is the specific bug we're closing.
  const worktreeMarker = "/.worktrees/";
  const idx = root.indexOf(worktreeMarker);
  if (idx <= 0) return { ok: true }; // boundary isn't a worktree shape — skip
  const repoRoot = root.slice(0, idx);
  // Tokenize on whitespace AND on `=` so `--cwd=/foo` is caught the same
  // as `--cwd /foo`. Quotation-stripping is naive but good enough for
  // common shell quoting patterns the agent emits.
  const tokens = command
    .split(/[\s=]+/)
    .map((t) => t.replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 0);
  for (const t of tokens) {
    if (!t.startsWith("/")) continue;
    if (!t.startsWith(repoRoot + "/") && t !== repoRoot) continue;
    if (t === root || t.startsWith(root + "/")) continue;
    return {
      ok: false,
      error:
        `Command rejected: token "${t}" points into the parent repo (${repoRoot}) ` +
        `but outside the worktree (${root}). Use relative paths or paths under the worktree.`,
    };
  }
  return { ok: true };
}
