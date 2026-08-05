/**
 * `aws-ec2` — TAI on a single EC2 instance with a persistent EBS root volume.
 *
 * One instance, deliberately. TAI's state is SQLite, which takes a single
 * writer, so there is no autoscaling group to build and no load balancer to
 * put in front. That also rules out Fargate/App Runner: SQLite on EFS breaks
 * WAL locking, and scale-to-zero stops cron and autopilot, which is most of
 * what a personal agent does when nobody is looking at it.
 *
 * Identity lives in EC2 tags, not in a local state file. `status` and `down`
 * find the instance by filtering on `tai:managed` and `tai:name`, so the
 * target works from any machine with credentials and there is no state to get
 * out of sync with reality.
 */

import type { DeployContext, DeployPlan, DeployResult, DeployStatus, DeployTarget } from "@tailored-ai/core";
import { Aws, type AwsRunner, defaultAwsRunner, isDryRunSuccess, isUnauthorized } from "./aws.js";
import { type AwsEc2Options, OptionError, parseOptions, validateOptions } from "./options.js";
import { renderUserData } from "./user-data.js";

const MANAGED_TAG = "tai:managed";
const NAME_TAG = "tai:name";

/** States that still count as "this deployment exists". A terminated instance
 * lingers in the API for about an hour and must not be mistaken for a live one. */
const LIVE_STATES = ["pending", "running", "stopping", "stopped"];

interface Instance {
  InstanceId: string;
  State: { Name: string };
  PublicIpAddress?: string;
  PrivateIpAddress?: string;
  InstanceType: string;
  LaunchTime?: string;
}

function findInstance(aws: Aws, name: string): { instance?: Instance; error?: string } {
  const { result, value } = aws.json<{ Reservations: Array<{ Instances: Instance[] }> }>([
    "ec2",
    "describe-instances",
    "--filters",
    `Name=tag:${MANAGED_TAG},Values=true`,
    `Name=tag:${NAME_TAG},Values=${name}`,
    `Name=instance-state-name,Values=${LIVE_STATES.join(",")}`,
  ]);
  if (!result.ok) return { error: result.stderr || "describe-instances failed" };
  const instances = (value?.Reservations ?? []).flatMap((r) => r.Instances ?? []);
  return { instance: instances[0] };
}

/** Latest Amazon Linux 2023 AMI for this region, from the SSM public parameter.
 * Hardcoding an AMI id would pin the deployment to one region and to whatever
 * was current the day it was written. */
function resolveAmi(aws: Aws): { ami?: string; error?: string } {
  const res = aws.text([
    "ssm",
    "get-parameter",
    "--name",
    "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
    "--query",
    "Parameter.Value",
  ]);
  if (!res.ok || !res.stdout) return { error: res.stderr || "could not resolve an AL2023 AMI" };
  return { ami: res.stdout };
}

/** The operator's public IP, so the SSH rule defaults to /32 rather than the
 * internet. Best-effort: a failure downgrades to "you must pass a CIDR". */
async function detectPublicIp(): Promise<string | undefined> {
  try {
    const res = await fetch("https://checkip.amazonaws.com", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const ip = (await res.text()).trim();
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) ? `${ip}/32` : undefined;
  } catch {
    return undefined;
  }
}

function ensureSecurityGroup(
  aws: Aws,
  opts: AwsEc2Options,
  vpcId: string,
  sshCidr: string | undefined,
): { groupId?: string; error?: string } {
  const groupName = `${opts.name}-sg`;

  const existing = aws.json<{ SecurityGroups: Array<{ GroupId: string }> }>([
    "ec2",
    "describe-security-groups",
    "--filters",
    `Name=group-name,Values=${groupName}`,
    `Name=vpc-id,Values=${vpcId}`,
  ]);
  const found = existing.value?.SecurityGroups?.[0]?.GroupId;
  if (found) return { groupId: found };

  const created = aws.json<{ GroupId: string }>([
    "ec2",
    "create-security-group",
    "--group-name",
    groupName,
    "--description",
    `Tailored AI (${opts.name})`,
    "--vpc-id",
    vpcId,
  ]);
  if (!created.value?.GroupId) {
    return { error: created.result.stderr || "create-security-group failed" };
  }
  const groupId = created.value.GroupId;

  // Ingress is opt-in per port. Nothing is opened that was not asked for —
  // notably not 3000, whose default is "no rule at all", because the bundled
  // dashboard cannot authenticate and the SSH tunnel is the supported path.
  if (sshCidr) {
    const res = aws.run([
      "ec2",
      "authorize-security-group-ingress",
      "--group-id",
      groupId,
      "--protocol",
      "tcp",
      "--port",
      "22",
      "--cidr",
      sshCidr,
    ]);
    if (!res.ok) return { error: `opening port 22: ${res.stderr}` };
  }
  if (opts.allowHttpFrom) {
    const res = aws.run([
      "ec2",
      "authorize-security-group-ingress",
      "--group-id",
      groupId,
      "--protocol",
      "tcp",
      "--port",
      "3000",
      "--cidr",
      opts.allowHttpFrom,
    ]);
    if (!res.ok) return { error: `opening port 3000: ${res.stderr}` };
  }

  return { groupId };
}

/**
 * @param groupId Security group to attach, or undefined to let AWS pick the
 *   VPC default. Undefined is what the `--dry-run` permission probe passes:
 *   the group does not exist yet at that point, and a placeholder id makes AWS
 *   reject the request on the fake value before it validates anything real —
 *   turning a useful probe into a confusing note about `groupId`.
 */
function launchArgs(opts: AwsEc2Options, ami: string, groupId: string | undefined, userData: string): string[] {
  const args = [
    "ec2",
    "run-instances",
    "--image-id",
    ami,
    "--instance-type",
    opts.instanceType,
    "--block-device-mappings",
    JSON.stringify([
      {
        DeviceName: "/dev/xvda",
        Ebs: { VolumeSize: opts.volumeSize, VolumeType: "gp3", DeleteOnTermination: true, Encrypted: true },
      },
    ]),
    "--metadata-options",
    // IMDSv2 required. The instance holds a provider API key on disk; leaving
    // the v1 endpoint enabled makes credential theft a single SSRF away.
    "HttpTokens=required,HttpEndpoint=enabled",
    "--tag-specifications",
    JSON.stringify([
      {
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: opts.name },
          { Key: MANAGED_TAG, Value: "true" },
          { Key: NAME_TAG, Value: opts.name },
        ],
      },
    ]),
    "--user-data",
    userData,
    "--count",
    "1",
  ];
  if (groupId) args.push("--security-group-ids", groupId);
  if (opts.keyName) args.push("--key-name", opts.keyName);
  if (opts.subnetId) args.push("--subnet-id", opts.subnetId);
  return args;
}

interface Preflight {
  problems: string[];
  notes: string[];
  opts?: AwsEc2Options;
  aws?: Aws;
  ami?: string;
  vpcId?: string;
  sshCidr?: string;
  existing?: Instance;
}

async function preflight(ctx: DeployContext, runner?: AwsRunner): Promise<Preflight> {
  const problems: string[] = [];
  const notes: string[] = [];

  // `aws configure get region` reads ~/.aws/config, which is where a region
  // lives on a machine that has only ever run `aws configure`. It exits
  // non-zero when unset, so a failure just means "no configured region".
  const configuredRegion = (() => {
    const res = (runner ?? defaultAwsRunner)(["configure", "get", "region"]);
    return res.ok && res.stdout ? res.stdout : undefined;
  })();

  let opts: AwsEc2Options;
  try {
    opts = parseOptions(ctx.args, process.env, configuredRegion);
  } catch (err) {
    if (err instanceof OptionError) return { problems: [err.message], notes };
    throw err;
  }

  problems.push(...validateOptions(opts));

  const aws = new Aws(opts.region, runner);

  const identity = aws.json<{ Account: string; Arn: string }>(["sts", "get-caller-identity"]);
  if (identity.result.missing) {
    return {
      problems: [...problems, "`aws` is not on PATH. Install the AWS CLI v2."],
      notes,
      opts,
    };
  }
  if (!identity.result.ok) {
    return {
      problems: [
        ...problems,
        `AWS credentials are not usable: ${identity.result.stderr || "sts get-caller-identity failed"}. ` +
          "Run `aws configure`, set AWS_PROFILE, or log in with `aws sso login`.",
      ],
      notes,
      opts,
    };
  }
  notes.push(`AWS account ${identity.value?.Account} as ${identity.value?.Arn}`);
  notes.push(`region ${opts.region}`);

  // An existing instance is not an error — `up` is an update in that case —
  // but it changes what the plan says, so resolve it before anything else.
  const { instance: existing, error: findError } = findInstance(aws, opts.name);
  if (findError) problems.push(`Could not list instances: ${findError}`);
  if (existing) {
    notes.push(`instance ${existing.InstanceId} already exists (${existing.State.Name}) and will be left alone`);
  }

  const ami = opts.ami ?? resolveAmi(aws).ami;
  if (!ami) problems.push("Could not resolve an Amazon Linux 2023 AMI. Pass --ami explicitly.");

  const vpc = aws.json<{ Vpcs: Array<{ VpcId: string }> }>([
    "ec2",
    "describe-vpcs",
    "--filters",
    "Name=isDefault,Values=true",
  ]);
  const vpcId = vpc.value?.Vpcs?.[0]?.VpcId;
  if (!vpcId && !opts.subnetId) {
    problems.push("No default VPC in this region. Pass --subnet-id to say where the instance should live.");
  }

  let sshCidr = opts.allowSshFrom;
  if (!sshCidr && opts.keyName) {
    sshCidr = await detectPublicIp();
    if (sshCidr) notes.push(`SSH will be allowed from ${sshCidr} (your detected public IP)`);
    else problems.push("Could not detect your public IP for the SSH rule. Pass --allow-ssh-from <cidr> explicitly.");
  }
  if (!opts.keyName) {
    notes.push(
      "No --key-name, so no SSH rule will be created. Use EC2 Instance Connect or Session Manager, " +
        "or re-run with --key-name to get a tunnel.",
    );
  }

  // Ask AWS whether the launch would actually be permitted, without launching.
  // This validates the whole request — AMI, type, block devices, tags,
  // user-data size — server-side, which is far better than checking IAM
  // policies by hand and hoping.
  if (ami && !existing) {
    const dry = aws.run(launchArgs(opts, ami, undefined, renderUserData(opts)).concat("--dry-run"));
    if (isUnauthorized(dry)) {
      problems.push(
        `Your credentials cannot launch instances here: ${dry.stderr}. ` +
          "The target needs ec2:RunInstances, CreateSecurityGroup, AuthorizeSecurityGroupIngress, " +
          "CreateTags, DescribeInstances, DescribeVpcs, DescribeSecurityGroups and ssm:GetParameter.",
      );
    } else if (isDryRunSuccess(dry)) {
      notes.push("AWS accepted the launch request (dry run) — instance type, AMI, volume and user-data all validate");
    } else if (!dry.ok) {
      // Anything else is a request AWS would reject for real. Surface it as a
      // problem, not a note: `up` would fail on the same request.
      problems.push(`AWS rejected the launch request: ${dry.stderr}`);
    }
  }

  return { problems, notes, opts, aws, ami, vpcId, sshCidr, existing };
}

/** Rough monthly cost, so a plan does not hide what it is about to start
 * billing. On-demand us-west-2 pricing, deliberately approximate. */
function estimateMonthlyCost(opts: AwsEc2Options): string {
  const hourly: Record<string, number> = {
    "t3.micro": 0.0104,
    "t3.small": 0.0208,
    "t3.medium": 0.0416,
    "t3.large": 0.0832,
    "t4g.small": 0.0168,
    "t4g.medium": 0.0336,
  };
  const rate = hourly[opts.instanceType];
  const ebs = opts.volumeSize * 0.08; // gp3, $/GB-month
  if (rate === undefined) return `EBS about $${ebs.toFixed(2)}/mo; instance pricing unknown for ${opts.instanceType}`;
  const compute = rate * 730;
  return `about $${(compute + ebs).toFixed(2)}/month (${opts.instanceType} $${compute.toFixed(2)} + ${opts.volumeSize}GB gp3 $${ebs.toFixed(2)}), plus egress`;
}

export function createAwsEc2Target(runner?: AwsRunner): DeployTarget {
  return {
    id: "aws-ec2",
    description: "Run TAI on a single EC2 instance with a persistent EBS volume.",
    help: `tai deploy up aws-ec2 -- [options]

Launches one EC2 instance running Amazon Linux 2023, which installs Docker,
clones TAI, builds the image, and starts it. State lives on the instance's
encrypted EBS root volume. The instance is found again by tag, so there is no
local state file.

Requires AWS CLI v2 with usable credentials (env, ~/.aws, AWS_PROFILE, or SSO).

Options:
  --region <r>              AWS region              [AWS_REGION, or configured]
  --name <n>                Deployment name, used for tags and the SG  (tai)
  --instance-type <t>       EC2 instance type       (t3.medium)
  --volume-size <gb>        Root EBS volume in GB   (20)
  --ami <id>                Override the AL2023 AMI lookup
  --key-name <k>            Existing EC2 key pair, enables SSH
  --allow-ssh-from <cidr>   Who may reach port 22   (your detected public IP)
  --allow-http-from <cidr>  Who may reach port 3000 (nobody)
  --force-public            Required to accept --allow-http-from 0.0.0.0/0
  --subnet-id <s>           Subnet to launch into   (default VPC)
  --repo <url>              Repo to build from
  --repo-ref <ref>          Branch or tag           (main)
  --model <name>            Model for the instance  [TAI_MODEL]  (required)
  --base-url <url>          Provider endpoint       [TAI_BASE_URL]
  --provider <id>           Provider factory id     [TAI_PROVIDER]
  --api-key <key>           Provider API key        [TAI_API_KEY]

Port 3000 is closed by default. TAI's bundled dashboard cannot send an API
token, so the supported way in is an SSH tunnel:

  ssh -L 3000:127.0.0.1:3000 ec2-user@<public-ip>

\`down\` terminates the instance and everything on it, including the database.`,

    async plan(ctx: DeployContext): Promise<DeployPlan> {
      const pre = await preflight(ctx, runner);
      const opts = pre.opts;
      if (!opts) return { steps: [], problems: pre.problems, notes: pre.notes };

      if (pre.existing) {
        return {
          problems: pre.problems,
          notes: pre.notes,
          steps: [
            {
              title: `leave instance ${pre.existing.InstanceId} running — \`up\` does not rebuild in place`,
            },
            { title: "to redeploy, run `tai deploy down aws-ec2` first (this destroys its data)" },
          ],
        };
      }

      return {
        problems: pre.problems,
        notes: [...pre.notes, estimateMonthlyCost(opts)],
        steps: [
          { title: `resolve the latest AL2023 AMI (${pre.ami ?? "unresolved"})` },
          { title: `create security group ${opts.name}-sg`, consequential: true },
          ...(pre.sshCidr ? [{ title: `allow port 22 from ${pre.sshCidr}`, consequential: true }] : []),
          ...(opts.allowHttpFrom
            ? [{ title: `allow port 3000 from ${opts.allowHttpFrom}`, consequential: true }]
            : [{ title: "leave port 3000 closed — reach the dashboard over an SSH tunnel" }]),
          {
            title: `launch one ${opts.instanceType} with a ${opts.volumeSize}GB encrypted gp3 root volume`,
            consequential: true,
          },
          { title: "cloud-init installs Docker, clones TAI, builds the image, starts the container" },
        ],
      };
    },

    async up(ctx: DeployContext): Promise<DeployResult> {
      const pre = await preflight(ctx, runner);
      if (pre.problems.length > 0 || !pre.opts || !pre.aws || !pre.ami) {
        return { ok: false, summary: "preflight failed", details: pre.problems };
      }
      const { opts, aws, ami } = pre;

      if (pre.existing) {
        return {
          ok: false,
          summary: `instance ${pre.existing.InstanceId} already exists for name "${opts.name}"`,
          details: [
            "This target does not update in place — the image is built on the instance at first boot.",
            "Redeploy with a new name (--name), or `tai deploy down aws-ec2` first (destroys its data).",
          ],
        };
      }

      const vpcId = pre.vpcId;
      if (!vpcId && !opts.subnetId) {
        return { ok: false, summary: "no VPC to launch into" };
      }

      ctx.log("Ensuring security group…");
      const sg = ensureSecurityGroup(aws, opts, vpcId ?? "", pre.sshCidr);
      if (!sg.groupId) return { ok: false, summary: "could not prepare the security group", details: [sg.error ?? ""] };

      ctx.log(`Launching ${opts.instanceType}…`);
      const launched = aws.json<{ Instances: Instance[] }>(launchArgs(opts, ami, sg.groupId, renderUserData(opts)));
      const instance = launched.value?.Instances?.[0];
      if (!instance) {
        return { ok: false, summary: "run-instances failed", details: [launched.result.stderr] };
      }

      ctx.log(`Waiting for ${instance.InstanceId} to start…`);
      const wait = aws.run(["ec2", "wait", "instance-running", "--instance-ids", instance.InstanceId]);
      if (!wait.ok) {
        return {
          ok: false,
          summary: `instance ${instance.InstanceId} did not reach "running"`,
          details: [wait.stderr, "It may still come up — check `tai deploy status aws-ec2`."],
        };
      }

      const described = findInstance(aws, opts.name);
      const ip = described.instance?.PublicIpAddress;

      return {
        ok: true,
        summary: `launched ${instance.InstanceId}`,
        url: ip ? `http://${ip}:3000` : undefined,
        details: [
          "The instance is now building the image — about 3-5 minutes on a t3.medium,",
          "longer on a smaller type. The container will not answer until it finishes.",
          "",
          ...(opts.keyName && ip
            ? [
                "Watch it:",
                `  ssh ec2-user@${ip} 'sudo tail -f /var/log/cloud-init-output.log'`,
                "",
                "Then reach the dashboard over a tunnel (port 3000 is closed to the internet):",
                `  ssh -L 3000:127.0.0.1:3000 ec2-user@${ip}`,
                "  open http://127.0.0.1:3000",
                "",
                "The generated API token is printed in the container log:",
                "  ssh ec2-user@" + ip + " 'cd /opt/tai/docker/tai && sudo docker compose logs tai'",
              ]
            : ["No key pair was given, so use EC2 Instance Connect or Session Manager to get on the box."]),
          "",
          `Cost: ${estimateMonthlyCost(opts)}. Tear it down with \`tai deploy down aws-ec2\`.`,
        ],
      };
    },

    async down(ctx: DeployContext): Promise<DeployResult> {
      const pre = await preflight(ctx, runner);
      if (!pre.opts || !pre.aws) return { ok: false, summary: "preflight failed", details: pre.problems };
      const { opts, aws } = pre;

      const { instance, error } = findInstance(aws, opts.name);
      if (error) return { ok: false, summary: "could not list instances", details: [error] };
      if (!instance) return { ok: true, summary: `nothing deployed under the name "${opts.name}"` };

      // Unlike the docker target, which stops a container and keeps its volume,
      // there is no halfway state here worth preserving: the root volume is
      // DeleteOnTermination and holds the database. Terminating is what "down"
      // has to mean for this target, so it says so rather than implying the
      // data survives.
      ctx.log(`Terminating ${instance.InstanceId}…`);
      const res = aws.run(["ec2", "terminate-instances", "--instance-ids", instance.InstanceId]);
      if (!res.ok) return { ok: false, summary: "terminate-instances failed", details: [res.stderr] };

      return {
        ok: true,
        summary: `terminating ${instance.InstanceId} — its EBS volume and the TAI database go with it`,
        details: [
          `The security group ${opts.name}-sg is left in place; it costs nothing and is reused on the next deploy.`,
          `Remove it with: aws ec2 delete-security-group --group-name ${opts.name}-sg --region ${opts.region}`,
        ],
      };
    },

    async status(ctx: DeployContext): Promise<DeployStatus> {
      const pre = await preflight(ctx, runner);
      if (!pre.opts || !pre.aws) return { state: "unknown", details: pre.problems };
      const { instance, error } = findInstance(pre.aws, pre.opts.name);
      if (error) return { state: "unknown", details: [error] };
      if (!instance) return { state: "not deployed" };

      return {
        state: instance.State.Name,
        url: instance.PublicIpAddress ? `http://${instance.PublicIpAddress}:3000` : undefined,
        details: [
          `${instance.InstanceId} (${instance.InstanceType})`,
          ...(instance.LaunchTime ? [`launched ${instance.LaunchTime}`] : []),
          ...(instance.PublicIpAddress
            ? [`tunnel: ssh -L 3000:127.0.0.1:3000 ec2-user@${instance.PublicIpAddress}`]
            : []),
        ],
      };
    },
  };
}

export const awsEc2Target = createAwsEc2Target();
