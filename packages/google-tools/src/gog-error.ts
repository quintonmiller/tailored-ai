/**
 * Turning a failed `gog` spawn into something an agent can act on.
 *
 * Every tool here shells out to the `gog` CLI and reports failures as
 * `stderr || "gog <verb> failed"`. When the binary is missing, `execFile` fails
 * with ENOENT and produces **no stderr at all**, so the fallback fires and the
 * agent is told "gog gmail search failed" — which reads as a Gmail problem.
 *
 * What that cost in one deployment: six days of the error room diagnosing an
 * OAuth token. The first failures really were `oauth2: "invalid_grant"` — gog
 * was installed and its credentials had expired. Later the binary went away,
 * stderr went empty, the message silently changed to the generic one, and five
 * successive diagnoses kept chasing the token because nothing ever said the
 * command did not exist.
 */

/** Node puts a string like "ENOENT" on `error.code` for spawn failures. */
export function spawnFailureReason(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") {
    return (
      "`gog` is not installed or not on PATH. This is not an authentication " +
      "problem — the command does not exist. Install it and run `gog auth login`."
    );
  }
  if (code === "EACCES") {
    return "`gog` was found but is not executable — check its permissions.";
  }
  return undefined;
}

/**
 * Pick the most useful message for a non-zero `gog` run. A spawn failure wins
 * over stderr because stderr is empty in exactly that case, and over the
 * caller's fallback because the fallback names the wrong subsystem.
 */
export function gogErrorMessage(spawnReason: string | undefined, stderr: string, fallback: string): string {
  return spawnReason ?? (stderr.trim() || fallback);
}
