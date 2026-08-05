/**
 * cloud-init user-data: everything that turns a bare AL2023 box into a running
 * TAI instance.
 *
 * This script runs once, as root, on first boot, with no terminal and nobody
 * watching. Two consequences shape all of it:
 *
 *  - **It must be idempotent-ish and loud.** Output goes to
 *    /var/log/cloud-init-output.log and that is the only forensic trail. Every
 *    step announces itself so a failed deploy can be diagnosed from one file.
 *  - **It must not embed secrets in the instance metadata.** User-data is
 *    readable by anything that can reach IMDS from inside the instance,
 *    including a compromised container. See `writeEnvFile` below.
 */

import type { AwsEc2Options } from "./options.js";

/**
 * Compose v2 is a CLI plugin, and AL2023's repos do not carry it — only the
 * `docker` engine. Pinning the release binary is more predictable than hoping
 * a package appears, and it keeps the deployed version reproducible.
 */
const COMPOSE_VERSION = "v2.32.4";

/** Shell-quote for a single-quoted bash string. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The env file the container reads.
 *
 * Written by the script rather than passed as container env so the values land
 * in a root-owned 0600 file on the instance's disk instead of in user-data.
 * An API key in user-data is retrievable forever by anything that can curl
 * IMDS; in a file it is at least subject to normal filesystem permissions.
 */
function writeEnvFile(opts: AwsEc2Options): string {
  const lines = [`TAI_MODEL=${opts.model ?? ""}`];
  if (opts.baseUrl) lines.push(`TAI_BASE_URL=${opts.baseUrl}`);
  if (opts.provider) lines.push(`TAI_PROVIDER=${opts.provider}`);
  if (opts.apiKey) lines.push(`TAI_API_KEY=${opts.apiKey}`);
  // Published to the instance's loopback only. The security group is the outer
  // gate; binding the published port to 127.0.0.1 means that even if the group
  // is later widened by hand, the dashboard is not instantly on the internet.
  lines.push("TAI_PUBLISH_ADDR=127.0.0.1");
  return lines.join("\n");
}

export function renderUserData(opts: AwsEc2Options): string {
  return `#!/bin/bash
# Provisioned by @tailored-ai/deploy-aws. Log: /var/log/cloud-init-output.log
set -euxo pipefail

echo "=== [tai] installing docker + git ==="
dnf update -y
dnf install -y docker git

echo "=== [tai] adding swap ==="
# The instance builds the TAI image locally (pnpm install, tsc, a Vite
# production build). Swap is what keeps that from being OOM-killed on a
# smaller instance type, and it is cheap insurance on a larger one.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "=== [tai] starting docker ==="
systemctl enable --now docker
usermod -aG docker ec2-user || true

echo "=== [tai] installing docker compose ${COMPOSE_VERSION} ==="
install -d /usr/local/lib/docker/cli-plugins
curl -fsSL \\
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" \\
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

echo "=== [tai] cloning ${opts.repo} @ ${opts.repoRef} ==="
rm -rf /opt/tai
git clone --depth 1 --branch ${sq(opts.repoRef)} ${sq(opts.repo)} /opt/tai

echo "=== [tai] writing environment ==="
cat > /opt/tai/docker/tai/.env <<'TAI_ENV_EOF'
${writeEnvFile(opts)}
TAI_ENV_EOF
chmod 600 /opt/tai/docker/tai/.env

echo "=== [tai] building and starting (this takes several minutes) ==="
cd /opt/tai/docker/tai
docker compose up -d --build

echo "=== [tai] installing systemd unit so it survives reboots ==="
# 'restart: unless-stopped' brings the container back when the DAEMON restarts,
# but nothing starts compose after an instance stop/start where the daemon
# comes up clean. This unit closes that gap.
cat > /etc/systemd/system/tai.service <<'TAI_UNIT_EOF'
[Unit]
Description=Tailored AI
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/tai/docker/tai
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose stop

[Install]
WantedBy=multi-user.target
TAI_UNIT_EOF
systemctl daemon-reload
systemctl enable tai.service

echo "=== [tai] provisioning complete ==="
# Marker file the deploy target polls for, so \`tai deploy up\` can distinguish
# "still building" from "finished" without parsing the cloud-init log.
touch /var/lib/tai-provisioned
`;
}
