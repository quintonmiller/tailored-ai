import type { DeployContext } from "@tailored-ai/core";
import { beforeEach, describe, expect, it } from "vitest";
import type { AwsResult, AwsRunner } from "../aws.js";
import { parseOptions } from "../options.js";
import { createAwsEc2Target } from "../target.js";
import { renderUserData } from "../user-data.js";

const ok = (stdout: string): AwsResult => ({ ok: true, stdout, stderr: "", missing: false });
const fail = (stderr: string, code?: string): AwsResult => ({ ok: false, stdout: "", stderr, missing: false, code });

/**
 * Fake `aws` CLI. Matches on the subcommand pair so tests only have to state
 * the calls they care about; anything unstubbed returns empty-but-successful,
 * which is what "no such resource" looks like from most describe calls.
 */
function runner(overrides: Record<string, AwsResult> = {}): AwsRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((args: string[]) => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    if (key in overrides) return overrides[key];
    switch (key) {
      case "sts get-caller-identity":
        return ok(JSON.stringify({ Account: "111122223333", Arn: "arn:aws:iam::111122223333:user/test" }));
      case "ssm get-parameter":
        return ok("ami-0test");
      case "ec2 describe-vpcs":
        return ok(JSON.stringify({ Vpcs: [{ VpcId: "vpc-0test" }] }));
      case "ec2 describe-instances":
        return ok(JSON.stringify({ Reservations: [] }));
      case "ec2 describe-security-groups":
        return ok(JSON.stringify({ SecurityGroups: [] }));
      case "ec2 create-security-group":
        return ok(JSON.stringify({ GroupId: "sg-0test" }));
      case "ec2 run-instances":
        // A --dry-run probe and a real launch share this key; tell them apart.
        return args.includes("--dry-run")
          ? fail("An error occurred (DryRunOperation) ...", "DryRunOperation")
          : ok(JSON.stringify({ Instances: [{ InstanceId: "i-0test", State: { Name: "pending" } }] }));
      default:
        return ok("{}");
    }
  }) as AwsRunner & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

function ctx(args: string[]): DeployContext {
  return { homeDir: "/home", configPath: "/home/config.yaml", args, log: () => {} };
}

const BASE_ARGS = ["--region", "us-west-2", "--model", "llama3.2", "--allow-ssh-from", "203.0.113.4/32"];

describe("aws-ec2 plan", () => {
  it("reports a clean plan and never launches anything", async () => {
    const run = runner();
    const target = createAwsEc2Target(run);
    const plan = await target.plan(ctx([...BASE_ARGS, "--key-name", "k"]));

    expect(plan.problems ?? []).toEqual([]);
    expect(plan.steps.some((s) => s.title.includes("launch one t3.medium"))).toBe(true);
    // plan() must not mutate. The only run-instances call allowed is a dry run.
    const launches = run.calls.filter((c) => c[0] === "ec2" && c[1] === "run-instances");
    expect(launches.every((c) => c.includes("--dry-run"))).toBe(true);
    expect(run.calls.some((c) => c[1] === "create-security-group")).toBe(false);
  });

  it("states the monthly cost so a plan does not hide what it starts billing", async () => {
    const plan = await createAwsEc2Target(runner()).plan(ctx([...BASE_ARGS, "--key-name", "k"]));
    expect((plan.notes ?? []).join()).toMatch(/\$\d+\.\d\d\/month/);
  });

  it("says port 3000 stays closed by default", async () => {
    const plan = await createAwsEc2Target(runner()).plan(ctx([...BASE_ARGS, "--key-name", "k"]));
    expect(plan.steps.some((s) => s.title.includes("leave port 3000 closed"))).toBe(true);
  });

  it("marks the launch as consequential", async () => {
    const plan = await createAwsEc2Target(runner()).plan(ctx([...BASE_ARGS, "--key-name", "k"]));
    expect(plan.steps.find((s) => s.title.includes("launch one"))?.consequential).toBe(true);
  });

  it("surfaces a bad option as a problem instead of throwing", async () => {
    const plan = await createAwsEc2Target(runner()).plan(ctx(["--region", "us-west-2", "--nope", "x"]));
    expect((plan.problems ?? []).join()).toMatch(/Unknown option/);
  });

  it("reports missing credentials in a way that names the fix", async () => {
    const run = runner({ "sts get-caller-identity": fail("Unable to locate credentials") });
    const plan = await createAwsEc2Target(run).plan(ctx(BASE_ARGS));
    expect((plan.problems ?? []).join()).toMatch(/aws configure|AWS_PROFILE|sso login/);
  });

  it("reports a missing aws binary as such", async () => {
    const run = (() => ({ ok: false, stdout: "", stderr: "", missing: true })) as AwsRunner;
    const plan = await createAwsEc2Target(run).plan(ctx(BASE_ARGS));
    expect((plan.problems ?? []).join()).toMatch(/not on PATH/);
  });

  it("turns an IAM denial into the list of permissions needed", async () => {
    const run = runner({
      "ec2 run-instances": fail("An error occurred (UnauthorizedOperation)", "UnauthorizedOperation"),
    });
    const plan = await createAwsEc2Target(run).plan(ctx(BASE_ARGS));
    expect((plan.problems ?? []).join()).toMatch(/ec2:RunInstances/);
  });

  it("does not offer to launch a second instance under the same name", async () => {
    const run = runner({
      "ec2 describe-instances": ok(
        JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: "i-0old", State: { Name: "running" } }] }] }),
      ),
    });
    const plan = await createAwsEc2Target(run).plan(ctx(BASE_ARGS));
    expect(plan.steps.some((s) => s.title.includes("does not rebuild in place"))).toBe(true);
  });
});

describe("aws-ec2 up", () => {
  it("creates the group, launches, waits, and reports", async () => {
    const run = runner();
    const res = await createAwsEc2Target(run).up(ctx([...BASE_ARGS, "--key-name", "k"]));
    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/i-0test/);

    const keys = run.calls.map((c) => `${c[0]} ${c[1]}`);
    expect(keys).toContain("ec2 create-security-group");
    expect(keys).toContain("ec2 run-instances");
    expect(keys).toContain("ec2 wait");
  });

  it("opens 22 but not 3000 when no HTTP CIDR is given", async () => {
    const run = runner();
    await createAwsEc2Target(run).up(ctx([...BASE_ARGS, "--key-name", "k"]));
    const ingress = run.calls.filter((c) => c[1] === "authorize-security-group-ingress");
    const ports = ingress.map((c) => c[c.indexOf("--port") + 1]);
    expect(ports).toEqual(["22"]);
  });

  it("opens 3000 only when explicitly asked", async () => {
    const run = runner();
    await createAwsEc2Target(run).up(ctx([...BASE_ARGS, "--key-name", "k", "--allow-http-from", "203.0.113.4/32"]));
    const ingress = run.calls.filter((c) => c[1] === "authorize-security-group-ingress");
    expect(ingress.map((c) => c[c.indexOf("--port") + 1]).sort()).toEqual(["22", "3000"]);
  });

  it("refuses to launch when preflight found problems", async () => {
    const run = runner();
    // No --model.
    const res = await createAwsEc2Target(run).up(ctx(["--region", "us-west-2"]));
    expect(res.ok).toBe(false);
    expect(run.calls.some((c) => c[1] === "run-instances" && !c.includes("--dry-run"))).toBe(false);
  });

  it("refuses when an instance already exists rather than launching a duplicate", async () => {
    const run = runner({
      "ec2 describe-instances": ok(
        JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: "i-0old", State: { Name: "running" } }] }] }),
      ),
    });
    const res = await createAwsEc2Target(run).up(ctx([...BASE_ARGS, "--key-name", "k"]));
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/already exists/);
    expect(run.calls.some((c) => c[1] === "run-instances" && !c.includes("--dry-run"))).toBe(false);
  });

  it("requires IMDSv2 on the launched instance", async () => {
    const run = runner();
    await createAwsEc2Target(run).up(ctx([...BASE_ARGS, "--key-name", "k"]));
    const launch = run.calls.find((c) => c[1] === "run-instances" && !c.includes("--dry-run"))!;
    expect(launch[launch.indexOf("--metadata-options") + 1]).toMatch(/HttpTokens=required/);
  });

  it("encrypts the root volume", async () => {
    const run = runner();
    await createAwsEc2Target(run).up(ctx([...BASE_ARGS, "--key-name", "k"]));
    const launch = run.calls.find((c) => c[1] === "run-instances" && !c.includes("--dry-run"))!;
    const mapping = JSON.parse(launch[launch.indexOf("--block-device-mappings") + 1]);
    expect(mapping[0].Ebs.Encrypted).toBe(true);
  });

  it("tags the instance so status and down can find it again", async () => {
    const run = runner();
    await createAwsEc2Target(run).up(ctx([...BASE_ARGS, "--key-name", "k"]));
    const launch = run.calls.find((c) => c[1] === "run-instances" && !c.includes("--dry-run"))!;
    const tags = JSON.parse(launch[launch.indexOf("--tag-specifications") + 1])[0].Tags;
    expect(tags).toEqual(
      expect.arrayContaining([
        { Key: "tai:managed", Value: "true" },
        { Key: "tai:name", Value: "tai" },
      ]),
    );
  });
});

describe("aws-ec2 down", () => {
  it("is a no-op when nothing is deployed", async () => {
    const run = runner();
    const res = await createAwsEc2Target(run).down!(ctx(BASE_ARGS));
    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/nothing deployed/);
    expect(run.calls.some((c) => c[1] === "terminate-instances")).toBe(false);
  });

  it("terminates and says plainly that the database goes too", async () => {
    const run = runner({
      "ec2 describe-instances": ok(
        JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: "i-0old", State: { Name: "running" } }] }] }),
      ),
    });
    const res = await createAwsEc2Target(run).down!(ctx(BASE_ARGS));
    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/database go with it/i);
    expect(run.calls.some((c) => c[1] === "terminate-instances")).toBe(true);
  });
});

describe("aws-ec2 status", () => {
  it("reports not deployed when no instance carries the tags", async () => {
    const status = await createAwsEc2Target(runner()).status!(ctx(BASE_ARGS));
    expect(status.state).toBe("not deployed");
  });

  it("reports the running instance and the tunnel command", async () => {
    const run = runner({
      "ec2 describe-instances": ok(
        JSON.stringify({
          Reservations: [
            {
              Instances: [
                {
                  InstanceId: "i-0test",
                  State: { Name: "running" },
                  PublicIpAddress: "203.0.113.9",
                  InstanceType: "t3.medium",
                },
              ],
            },
          ],
        }),
      ),
    });
    const status = await createAwsEc2Target(run).status!(ctx(BASE_ARGS));
    expect(status.state).toBe("running");
    expect(status.details?.join()).toMatch(/ssh -L 3000:127\.0\.0\.1:3000/);
  });

  it("ignores terminated instances so a dead deploy does not look alive", async () => {
    const run = runner();
    await createAwsEc2Target(run).status!(ctx(BASE_ARGS));
    const describe = run.calls.find((c) => c[1] === "describe-instances")!;
    const states = describe[describe.indexOf("--filters") + 3];
    expect(states).not.toMatch(/terminated/);
  });
});

describe("user-data", () => {
  const opts = () => parseOptions(["--region", "us-west-2", "--model", "llama3.2"]);

  it("publishes the container port to loopback only", () => {
    // Defence in depth: even if the security group is later widened by hand,
    // the dashboard is not instantly on the internet.
    expect(renderUserData(opts())).toMatch(/TAI_PUBLISH_ADDR=127\.0\.0\.1/);
  });

  it("locks down the env file that holds the API key", () => {
    expect(renderUserData(opts())).toMatch(/chmod 600 \/opt\/tai\/docker\/tai\/\.env/);
  });

  it("adds swap so the image build is not OOM-killed", () => {
    expect(renderUserData(opts())).toMatch(/mkswap \/swapfile/);
  });

  it("installs a unit so the container returns after an instance restart", () => {
    expect(renderUserData(opts())).toMatch(/systemctl enable tai\.service/);
  });

  it("escapes a single quote in an option rather than breaking out of the shell string", () => {
    const o = parseOptions(["--region", "us-west-2", "--model", "m", "--repo-ref", "it's-a-branch"]);
    const script = renderUserData(o);
    expect(script).toContain(`'it'\\''s-a-branch'`);
  });

  it("aborts the whole script on any failing step", () => {
    expect(renderUserData(opts())).toMatch(/set -euxo pipefail/);
  });
});
