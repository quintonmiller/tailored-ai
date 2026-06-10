import { describe, expect, it } from "vitest";
import { defaultDraft } from "../editor/types.js";
import { hydrateFromYaml, patchExistingYaml, renderNewConfig } from "../setup.js";

const HOME = "/home/test/.tai";

describe("hydrateFromYaml channels", () => {
  it("seeds discord even when the config has no channels block", () => {
    const draft = hydrateFromYaml("server:\n  port: 3000\n", HOME);
    expect(draft.channels).toEqual({ discord: false });
  });

  it("reads enabled flags from every channel block, no id special-cased", () => {
    const yaml = `channels:
  discord:
    enabled: true
  slack:
    enabled: false
  telegram:
    enabled: true
`;
    const draft = hydrateFromYaml(yaml, HOME);
    expect(draft.channels).toEqual({ discord: true, slack: false, telegram: true });
  });

  it("keeps discord seeded false when other channels are present without discord", () => {
    const yaml = `channels:
  slack:
    enabled: true
`;
    const draft = hydrateFromYaml(yaml, HOME);
    expect(draft.channels.discord).toBe(false);
    expect(draft.channels.slack).toBe(true);
  });
});

describe("renderNewConfig channels", () => {
  it("always emits the built-in discord block reflecting its toggle", () => {
    const draft = { ...defaultDraft(HOME), channels: { discord: true } };
    const yaml = renderNewConfig(draft);
    expect(yaml).toContain("channels:");
    expect(yaml).toContain("discord:");
    expect(yaml).toContain("enabled: true");
    // Round-trips back through hydrate.
    expect(hydrateFromYaml(yaml, HOME).channels.discord).toBe(true);
  });

  it("emits the discord block disabled when off", () => {
    const draft = { ...defaultDraft(HOME), channels: { discord: false } };
    const yaml = renderNewConfig(draft);
    expect(hydrateFromYaml(yaml, HOME).channels.discord).toBe(false);
  });
});

describe("patchExistingYaml channels", () => {
  const base = `channels:
  discord:
    enabled: false
    token: tok
  slack:
    enabled: false
`;

  it("writes channels.<id>.enabled generically for a non-discord channel", () => {
    const original = hydrateFromYaml(base, HOME);
    const edited = { ...original, channels: { ...original.channels, slack: true } };
    const { text, changes } = patchExistingYaml(base, original, edited);
    expect(changes).toContain("channels.slack.enabled: false → true");
    // Discord block preserved, slack flipped.
    const rehydrated = hydrateFromYaml(text, HOME);
    expect(rehydrated.channels.slack).toBe(true);
    expect(rehydrated.channels.discord).toBe(false);
  });

  it("toggles discord through the same generic path", () => {
    const original = hydrateFromYaml(base, HOME);
    const edited = { ...original, channels: { ...original.channels, discord: true } };
    const { text, changes } = patchExistingYaml(base, original, edited);
    expect(changes).toContain("channels.discord.enabled: false → true");
    expect(hydrateFromYaml(text, HOME).channels.discord).toBe(true);
  });

  it("creates a brand-new channel block when toggling an id absent from config", () => {
    const original = hydrateFromYaml(base, HOME);
    const edited = { ...original, channels: { ...original.channels, telegram: true } };
    const { text, changes } = patchExistingYaml(base, original, edited);
    expect(changes).toContain("channels.telegram.enabled: false → true");
    expect(hydrateFromYaml(text, HOME).channels.telegram).toBe(true);
  });

  it("emits no channel change when nothing toggled", () => {
    const original = hydrateFromYaml(base, HOME);
    const { changes } = patchExistingYaml(base, original, original);
    expect(changes.filter((c) => c.startsWith("channels."))).toHaveLength(0);
  });
});
