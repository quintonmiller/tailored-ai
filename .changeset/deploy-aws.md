---
"@tailored-ai/deploy-aws": patch
---

New package: AWS deploy target. `tai deploy up aws-ec2` runs TAI on a single
EC2 instance with an encrypted EBS root volume.

One instance, deliberately — TAI's state is SQLite and takes a single writer,
which also rules out Fargate/App Runner (SQLite on EFS breaks WAL locking, and
scale-to-zero stops cron and autopilot).

Talks to AWS through the `aws` CLI rather than the SDK, matching how the repo
already shells out to `gh` and `docker`, and so credentials work however they
already work for the user — env, `~/.aws`, `AWS_PROFILE`, SSO — with no second
credential path to get wrong.

`plan` sends the real launch request with `--dry-run`, so AWS validates the
AMI, instance type, volume, tags, user-data and IAM permissions server-side
before anything is created; `up` refuses when that comes back with a problem.

Secure by default: port 3000 is closed (the bundled dashboard cannot send an
API token, so the supported path in is an SSH tunnel), `--allow-http-from
0.0.0.0/0` additionally requires `--force-public`, the root volume is
encrypted, IMDSv2 is required, and the provider API key is written to a
root-owned 0600 file rather than passed through instance user-data.

Deployment identity lives in EC2 tags, so `status` and `down` work from any
machine with credentials and there is no local state file to desync.
