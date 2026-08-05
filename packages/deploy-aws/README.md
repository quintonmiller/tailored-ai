# @tailored-ai/deploy-aws

AWS deploy target for [Tailored AI](https://github.com/quintonmiller/tailored-ai). Runs TAI on a single EC2 instance with a persistent, encrypted EBS volume.

```bash
tai plugin install @tailored-ai/deploy-aws
tai deploy plan aws-ec2 -- --model llama3.2 --key-name my-key
tai deploy up   aws-ec2 -- --model llama3.2 --key-name my-key
```

## One instance, deliberately

TAI's state is SQLite, which takes a single writer. There is no autoscaling group to build and no load balancer to put in front — scale by giving the box more, not by adding boxes.

That also rules out Fargate, App Runner and Cloud Run: SQLite on EFS breaks WAL locking, and scale-to-zero stops cron and autopilot, which is most of what a personal agent does when nobody is looking at it.

## What `up` does

1. Resolves the latest Amazon Linux 2023 AMI for your region from SSM.
2. Creates a security group (`<name>-sg`) and opens **only** what you asked for.
3. Launches one instance with an encrypted gp3 root volume and IMDSv2 required.
4. cloud-init installs Docker, clones TAI, builds the image, starts the container, and installs a systemd unit so it comes back after a reboot.

The build happens on the instance. Measured at about 3m30s on a `t3.medium`
from `run-instances` to a healthy container; a smaller instance type will be
slower. Watch it:

```bash
ssh ec2-user@<ip> 'sudo tail -f /var/log/cloud-init-output.log'
```

## Getting in

**Port 3000 is closed by default.** The instance serves plain HTTP, so an open port is unauthenticated (or carries a `proxyAuth` password in cleartext) until you put TLS in front of it. The tunnel needs neither:

```bash
ssh -L 3000:127.0.0.1:3000 ec2-user@<ip>
# then open http://127.0.0.1:3000
```

The generated API token is printed once in the container log:

```bash
ssh ec2-user@<ip> 'cd /opt/tai/docker/tai && sudo docker compose logs tai'
```

If you want the port open, `--allow-http-from <cidr>` does it. `0.0.0.0/0` additionally requires `--force-public`, because publishing an unencrypted dashboard to the whole internet should not be reachable by typing a CIDR.

For a durable public deployment, set `server.proxyAuth` on the instance and put a TLS-terminating proxy in front. [Self-hosting](../../docs/self-hosting.md) covers both.

## Options

Everything goes after `--`:

| Flag | Default | |
|---|---|---|
| `--region <r>` | `AWS_REGION`, else your configured profile | |
| `--name <n>` | `tai` | Names tags and the security group |
| `--instance-type <t>` | `t3.medium` | |
| `--volume-size <gb>` | `20` | |
| `--ami <id>` | latest AL2023 | |
| `--key-name <k>` | — | Existing EC2 key pair; enables SSH |
| `--allow-ssh-from <cidr>` | your detected public IP | |
| `--allow-http-from <cidr>` | nobody | |
| `--force-public` | off | Required for `0.0.0.0/0` |
| `--subnet-id <s>` | default VPC | |
| `--repo` / `--repo-ref` | this repo / `main` | What to build |
| `--model <name>` | `TAI_MODEL` | **Required** |
| `--base-url <url>` | `TAI_BASE_URL` | |
| `--provider <id>` | `TAI_PROVIDER` | |
| `--api-key <key>` | `TAI_API_KEY` | |

`t3.medium` rather than the cheaper `t3.small` because the instance builds the image itself — a pnpm install, a `tsc -b`, and a Vite production build. On 2 GB that gets OOM-killed. Once TAI publishes a prebuilt image, `t3.small` becomes the right default.

## Credentials

Uses the AWS CLI v2, so credentials work however they already do for you: environment variables, `~/.aws/credentials`, `AWS_PROFILE`, SSO, or an instance role. This plugin adds no second credential path.

Permissions needed: `ec2:RunInstances`, `CreateSecurityGroup`, `AuthorizeSecurityGroupIngress`, `CreateTags`, `DescribeInstances`, `DescribeVpcs`, `DescribeSecurityGroups`, `TerminateInstances`, and `ssm:GetParameter`.

`plan` verifies this for you: it sends the real launch request with `--dry-run`, so AWS validates the AMI, instance type, volume, tags, user-data and your IAM permissions server-side without creating anything.

## State lives in tags

`status` and `down` find the instance by filtering on `tai:managed` and `tai:name`. There is no local state file to get out of sync, and the target works from any machine with credentials.

## Tearing down

```bash
tai deploy down aws-ec2
```

Terminates the instance. **The root volume is `DeleteOnTermination` and holds the database, so this destroys your TAI state.** Unlike the built-in `docker` target — which stops a container and keeps its volume — there is no halfway state here worth preserving, and the command says so rather than implying the data survives.

The security group is left in place; it costs nothing and is reused next time.

## Security notes

- Root volume is encrypted.
- IMDSv2 is required (`HttpTokens=required`), so a container-level SSRF cannot walk off with instance credentials.
- The provider API key is written to a root-owned `0600` file on the instance, not passed through user-data — anything that can read instance metadata can read user-data forever.
- The container publishes its port to the instance's loopback only, so widening the security group by hand does not instantly put the dashboard on the internet.

## License

MIT
