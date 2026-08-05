/**
 * Thin wrapper over the `aws` CLI.
 *
 * Shelling out rather than depending on `@aws-sdk/*` matches how the rest of
 * this repo talks to external systems — `GhRepoBackend` shells out to `gh`,
 * the built-in `docker` deploy target shells out to `docker` — and it keeps a
 * plugin that most users will never install from dragging tens of megabytes of
 * SDK into `<TAI_HOME>/plugins/`.
 *
 * It also means credentials work exactly the way the user already expects:
 * environment variables, `~/.aws/credentials`, `AWS_PROFILE`, SSO, instance
 * roles. There is no second credential path for this plugin to get wrong.
 */

import { spawnSync } from "node:child_process";

export interface AwsResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when the `aws` binary itself is not installed. */
  missing: boolean;
  /** AWS error code parsed from stderr, e.g. "UnauthorizedOperation". */
  code?: string;
}

/**
 * Injected so tests can drive the target without an AWS account. Production
 * wiring uses {@link defaultAwsRunner}.
 */
export type AwsRunner = (args: string[]) => AwsResult;

/** `An error occurred (Code) when calling the X operation: message` */
const ERROR_CODE = /An error occurred \(([^)]+)\)/;

export const defaultAwsRunner: AwsRunner = (args) => {
  const res = spawnSync("aws", args, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  const stderr = (res.stderr ?? "").trim();
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr,
    missing: (res.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
    code: ERROR_CODE.exec(stderr)?.[1],
  };
};

/**
 * A `--dry-run` call that AWS accepted. The CLI exits non-zero and reports
 * `DryRunOperation` when the request WOULD have succeeded, so the success
 * signal for a dry run is an error code — inverted from every other call, and
 * the kind of thing that silently reads as failure if it is not named.
 */
export function isDryRunSuccess(result: AwsResult): boolean {
  return result.code === "DryRunOperation";
}

/** True when the failure is a permissions problem rather than a bad request. */
export function isUnauthorized(result: AwsResult): boolean {
  return (
    result.code === "UnauthorizedOperation" || result.code === "AccessDenied" || result.code === "AccessDeniedException"
  );
}

export class Aws {
  constructor(
    private readonly region: string,
    private readonly runner: AwsRunner = defaultAwsRunner,
  ) {}

  /** Run an aws command with `--region` and `--output json` appended. */
  run(args: string[]): AwsResult {
    return this.runner([...args, "--region", this.region, "--output", "json"]);
  }

  /** Run and parse stdout as JSON. Returns undefined on failure or bad JSON. */
  json<T>(args: string[]): { result: AwsResult; value?: T } {
    const result = this.run(args);
    if (!result.ok || !result.stdout) return { result };
    try {
      return { result, value: JSON.parse(result.stdout) as T };
    } catch {
      return { result };
    }
  }

  /** Run with `--output text`, for single-value queries. */
  text(args: string[]): AwsResult {
    return this.runner([...args, "--region", this.region, "--output", "text"]);
  }
}
