import { describe, expect, it } from "vitest";
import { DEFAULT_INSTANCE_TYPE, OptionError, parseOptions, validateOptions } from "../options.js";

const env = { AWS_REGION: "us-west-2" } as NodeJS.ProcessEnv;

describe("parseOptions", () => {
  it("applies defaults", () => {
    const o = parseOptions([], env);
    expect(o.region).toBe("us-west-2");
    expect(o.name).toBe("tai");
    expect(o.instanceType).toBe(DEFAULT_INSTANCE_TYPE);
    expect(o.volumeSize).toBe(20);
    expect(o.allowHttpFrom).toBeUndefined();
  });

  it("requires a region from somewhere", () => {
    expect(() => parseOptions([], {} as NodeJS.ProcessEnv)).toThrow(/No region/);
  });

  it("prefers a flag over the environment", () => {
    expect(parseOptions(["--region", "eu-west-1"], env).region).toBe("eu-west-1");
  });

  // Regression: a machine configured only with `aws configure` has a region in
  // ~/.aws/config and no AWS_REGION. Ignoring that made the target refuse to
  // run on the normal AWS setup while every `aws` command worked.
  it("falls back to the configured profile region", () => {
    expect(parseOptions([], {} as NodeJS.ProcessEnv, "us-west-2").region).toBe("us-west-2");
  });

  it("prefers the environment over the configured profile", () => {
    expect(parseOptions([], env, "eu-central-1").region).toBe("us-west-2");
  });

  it("prefers a flag over the configured profile", () => {
    expect(parseOptions(["--region", "ap-south-1"], env, "eu-central-1").region).toBe("ap-south-1");
  });

  it("reads model settings from the environment", () => {
    const o = parseOptions([], { ...env, TAI_MODEL: "llama3.2", TAI_BASE_URL: "http://x/v1" });
    expect(o.model).toBe("llama3.2");
    expect(o.baseUrl).toBe("http://x/v1");
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    // Silently dropping a typo'd flag on a command that launches billable
    // infrastructure is the wrong failure mode.
    expect(() => parseOptions(["--instance-typo", "t3.large"], env)).toThrow(OptionError);
  });

  it("rejects a flag with no value", () => {
    expect(() => parseOptions(["--instance-type"], env)).toThrow(/needs a value/);
  });

  it("rejects a flag whose value is the next flag", () => {
    expect(() => parseOptions(["--instance-type", "--name", "x"], env)).toThrow(/needs a value/);
  });

  it("rejects a non-numeric volume size", () => {
    expect(() => parseOptions(["--volume-size", "20GB"], env)).toThrow(/integer number of GB/);
  });

  it("rejects a volume too small to hold the build", () => {
    expect(() => parseOptions(["--volume-size", "4"], env)).toThrow(/at least 8/);
  });

  it("rejects a malformed CIDR", () => {
    expect(() => parseOptions(["--allow-ssh-from", "203.0.113.4"], env)).toThrow(/CIDR/);
  });

  it("rejects a name that would break a security group", () => {
    expect(() => parseOptions(["--name", "my tai!"], env)).toThrow(/--name must be/);
  });
});

describe("validateOptions", () => {
  const base = () => parseOptions(["--model", "m"], env);

  it("passes with a model and no exposure", () => {
    expect(validateOptions(base())).toEqual([]);
  });

  it("requires a model", () => {
    expect(validateOptions(parseOptions([], env)).join()).toMatch(/No model/);
  });

  it("blocks a world-open dashboard by default", () => {
    const o = parseOptions(["--model", "m", "--key-name", "k", "--allow-http-from", "0.0.0.0/0"], env);
    expect(validateOptions(o).join()).toMatch(/entire internet/);
  });

  it("allows a world-open dashboard only with an explicit override", () => {
    const o = parseOptions(
      ["--model", "m", "--key-name", "k", "--allow-http-from", "0.0.0.0/0", "--force-public"],
      env,
    );
    expect(validateOptions(o)).toEqual([]);
  });

  it("allows a narrow HTTP CIDR without the override", () => {
    const o = parseOptions(["--model", "m", "--key-name", "k", "--allow-http-from", "203.0.113.4/32"], env);
    expect(validateOptions(o)).toEqual([]);
  });

  it("objects to opening HTTP with no way to SSH in", () => {
    const o = parseOptions(["--model", "m", "--allow-http-from", "203.0.113.4/32"], env);
    expect(validateOptions(o).join()).toMatch(/no SSH access/);
  });
});
