/**
 * AWS deploy target for Tailored AI.
 *
 *   tai plugin install @tailored-ai/deploy-aws
 *   tai deploy plan aws-ec2 -- --model llama3.2 --key-name my-key
 *   tai deploy up   aws-ec2 -- --model llama3.2 --key-name my-key
 *
 * Contributed through the `deployTargets` named export rather than a
 * `register(ctx)` default export: deploy targets are discovered by
 * installation, before a config.yaml necessarily exists, because `tai deploy`
 * is often the command that creates the instance a config would describe.
 * See docs/deploy-targets.md.
 *
 * There is deliberately no top-level side effect here — the CLI imports this
 * module just to enumerate targets.
 */

import type { DeployTargets } from "@tailored-ai/core";
import { awsEc2Target } from "./target.js";

export const deployTargets: DeployTargets = [awsEc2Target];

export { type AwsEc2Options, parseOptions, validateOptions } from "./options.js";
export { createAwsEc2Target } from "./target.js";
export { renderUserData } from "./user-data.js";

/** Self-description read by the plugin loader when this package is also listed
 * under `plugins:`. Harmless when it is not. */
export const meta = {
  name: "@tailored-ai/deploy-aws",
  description: "Deploy TAI to a single EC2 instance with a persistent EBS volume.",
};
