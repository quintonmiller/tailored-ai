/**
 * Option parsing for the `aws-ec2` target.
 *
 * Everything arrives after `--` on the command line:
 *
 *   tai deploy up aws-ec2 -- --instance-type t3.large --model llama3.2
 *
 * Deploy targets are discovered before a config.yaml necessarily exists (see
 * docs/deploy-targets.md), so flags and the ambient AWS environment are the
 * only inputs. Nothing here reads config.yaml.
 */

/** Default instance type.
 *
 * t3.medium (4 GB), not the cheaper t3.small (2 GB), because the instance
 * builds the TAI image itself: a pnpm install plus `tsc -b` plus a Vite
 * production build. On 2 GB that either OOM-kills the build or thrashes swap
 * for an hour, and the failure surfaces as a container that never appears with
 * the real cause buried in cloud-init logs.
 *
 * A prebuilt image now exists (`ghcr.io/quintonmiller/tai`, #374) and it is
 * down to ~670 MB (#375), so the remaining work for a t3.small default is in
 * user-data.ts: `docker pull` the published tag instead of cloning and
 * building. Note that only `:edge` publishes automatically — `:latest` is
 * gated on a `docker-publish` environment that has to exist first. Sizing is
 * about the build, not the pull; do not drop this without that change. */
export const DEFAULT_INSTANCE_TYPE = "t3.medium";

/** Root volume size in GB. The image build plus its layer cache needs well
 * more than AL2023's 8 GB default; 20 leaves room for the database to grow. */
export const DEFAULT_VOLUME_SIZE = 20;

export const DEFAULT_NAME = "tai";
export const DEFAULT_REPO = "https://github.com/quintonmiller/tailored-ai.git";
export const DEFAULT_REPO_REF = "main";

export interface AwsEc2Options {
  region: string;
  /** Names the instance, its security group, and its tags. */
  name: string;
  instanceType: string;
  volumeSize: number;
  /** Explicit AMI. Omitted means "resolve the latest AL2023 from SSM". */
  ami?: string;
  /** Existing EC2 key pair name, for SSH access. */
  keyName?: string;
  /** CIDR allowed to reach port 22. Omitted means "detect my public IP". */
  allowSshFrom?: string;
  /** CIDR allowed to reach port 3000. Omitted means nobody — the default. */
  allowHttpFrom?: string;
  /** Required to accept `--allow-http-from 0.0.0.0/0`. */
  forcePublic: boolean;
  /** Subnet to launch into. Omitted means the default VPC's first subnet. */
  subnetId?: string;
  repo: string;
  repoRef: string;
  // Passed through to `tai init --non-interactive` on the instance.
  model?: string;
  baseUrl?: string;
  provider?: string;
  apiKey?: string;
}

export class OptionError extends Error {}

const FLAGS_WITH_VALUES = new Set([
  "--region",
  "--name",
  "--instance-type",
  "--volume-size",
  "--ami",
  "--key-name",
  "--allow-ssh-from",
  "--allow-http-from",
  "--subnet-id",
  "--repo",
  "--repo-ref",
  "--model",
  "--base-url",
  "--provider",
  "--api-key",
]);

const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

/**
 * @param configuredRegion Region from `aws configure get region`, i.e. the
 *   `~/.aws/config` profile. The caller supplies it because reading it means
 *   shelling out and this function stays pure. Leaving it out was a real bug:
 *   a machine with a configured region and no `AWS_REGION` — the normal state
 *   after `aws configure` — had every `aws` command working while this target
 *   refused for want of a region.
 */
export function parseOptions(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  configuredRegion?: string,
): AwsEc2Options {
  const raw = new Map<string, string>();
  let forcePublic = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--force-public") {
      forcePublic = true;
      continue;
    }
    if (!FLAGS_WITH_VALUES.has(arg)) {
      throw new OptionError(`Unknown option "${arg}". Run \`tai deploy help aws-ec2\` for the list.`);
    }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new OptionError(`Option "${arg}" needs a value.`);
    }
    raw.set(arg, value);
  }

  // Mirrors the AWS CLI's own precedence — flag, then AWS_REGION, then
  // AWS_DEFAULT_REGION, then the configured profile — so this plugin cannot
  // disagree with the `aws` commands it shells out to.
  const region = raw.get("--region") ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? configuredRegion;
  if (!region) {
    throw new OptionError(
      "No region. Pass --region, set AWS_REGION, or configure one with `aws configure set region <region>`.",
    );
  }

  const volumeSizeRaw = raw.get("--volume-size") ?? String(DEFAULT_VOLUME_SIZE);
  if (!/^\d+$/.test(volumeSizeRaw)) {
    throw new OptionError(`--volume-size must be an integer number of GB, got "${volumeSizeRaw}".`);
  }
  const volumeSize = Number.parseInt(volumeSizeRaw, 10);
  if (volumeSize < 8) throw new OptionError("--volume-size must be at least 8 GB.");

  for (const flag of ["--allow-ssh-from", "--allow-http-from"] as const) {
    const value = raw.get(flag);
    if (value !== undefined && !CIDR.test(value)) {
      throw new OptionError(`${flag} must be a CIDR block like 203.0.113.4/32, got "${value}".`);
    }
  }

  const name = raw.get("--name") ?? DEFAULT_NAME;
  // The name becomes a security-group name and a tag value; keep it to
  // something both accept so a bad name fails here rather than three API
  // calls later with an opaque AWS validation error.
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    throw new OptionError(`--name must be 1-64 chars of letters, digits, dot, dash or underscore, got "${name}".`);
  }

  return {
    region,
    name,
    instanceType: raw.get("--instance-type") ?? DEFAULT_INSTANCE_TYPE,
    volumeSize,
    ami: raw.get("--ami"),
    keyName: raw.get("--key-name"),
    allowSshFrom: raw.get("--allow-ssh-from"),
    allowHttpFrom: raw.get("--allow-http-from"),
    forcePublic,
    subnetId: raw.get("--subnet-id"),
    repo: raw.get("--repo") ?? DEFAULT_REPO,
    repoRef: raw.get("--repo-ref") ?? DEFAULT_REPO_REF,
    model: raw.get("--model") ?? env.TAI_MODEL,
    baseUrl: raw.get("--base-url") ?? env.TAI_BASE_URL,
    provider: raw.get("--provider") ?? env.TAI_PROVIDER,
    apiKey: raw.get("--api-key") ?? env.TAI_API_KEY,
  };
}

/**
 * Preconditions that are about the options themselves, not about AWS. Returned
 * as plan `problems` so `up` refuses before making a single API call.
 */
export function validateOptions(opts: AwsEc2Options): string[] {
  const problems: string[] = [];

  if (!opts.model) {
    problems.push(
      "No model. Pass --model <name> (or set TAI_MODEL). The instance runs " +
        "`tai init --non-interactive`, which refuses to guess one.",
    );
  }

  // Opening the dashboard to the world is a different thing from opening it to
  // your office. This target cannot see the instance's config, so it cannot
  // know whether server.proxyAuth is set there, and a plain HTTP port on a
  // public IP carries the login password in cleartext even when it is.
  if (opts.allowHttpFrom === "0.0.0.0/0" && !opts.forcePublic) {
    problems.push(
      "--allow-http-from 0.0.0.0/0 publishes port 3000 to the entire internet, over plain " +
        "HTTP. Anyone who finds the IP reads chat history, memory and tool output unless " +
        "server.proxyAuth is configured on the instance, and even then the password crosses " +
        "the wire in cleartext. Use the SSH tunnel (the default), put a TLS-terminating " +
        "proxy in front, or pass --force-public if you have genuinely accounted for this.",
    );
  }

  if (opts.allowHttpFrom && !opts.keyName) {
    // Not fatal, but worth saying: without a key there is no tunnel fallback.
    problems.push(
      "--allow-http-from without --key-name leaves no SSH access at all. Supply a key pair " +
        "so you can reach the instance if the HTTP path turns out to be wrong.",
    );
  }

  return problems;
}
