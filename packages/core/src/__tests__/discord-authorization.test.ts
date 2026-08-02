/**
 * Slash-command authorization.
 *
 * The hole this closes: `shouldRespond` gates MessageCreate, and interactions
 * arrive on a different listener that read none of it. Every slash command —
 * including the ones that stop the deployment or rewrite an agent's memory —
 * was reachable by anyone who could see the bot.
 */
import { describe, expect, it } from "vitest";
import {
  authorizeInteraction,
  OWNER_ONLY_COMMANDS,
  OWNER_ONLY_SUBCOMMANDS,
  requiresOwner,
} from "../channels/discord-authorization.js";

const OWNER = "111111111111111111";
const STRANGER = "999999999999999999";
const GUILD = "1234567890123456789";

const id = (over: Partial<Parameters<typeof authorizeInteraction>[0]> = {}) => ({
  commandName: "help",
  userId: OWNER,
  guildId: GUILD,
  ...over,
});

describe("guild allowlist", () => {
  /** Declared config that the interaction path simply never read. */
  it("refuses a guild that is not on the allowlist", () => {
    const d = authorizeInteraction(id({ guildId: "222222222222222222" }), { owner: OWNER, allowedGuilds: [GUILD] });

    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toMatch(/allowedGuilds/);
  });

  it("admits a guild on the allowlist", () => {
    expect(authorizeInteraction(id(), { owner: OWNER, allowedGuilds: [GUILD] }).ok).toBe(true);
  });

  it("admits any guild when no allowlist is configured", () => {
    expect(authorizeInteraction(id({ guildId: "777777777777777777" }), { owner: OWNER }).ok).toBe(true);
  });

  /** DMs have no guild; the allowlist cannot speak to them either way. */
  it("does not apply the allowlist to a DM", () => {
    expect(authorizeInteraction(id({ guildId: undefined }), { owner: OWNER, allowedGuilds: [GUILD] }).ok).toBe(true);
  });
});

describe("owner-only commands", () => {
  it.each(OWNER_ONLY_COMMANDS)("refuses /%s to a non-owner", (commandName) => {
    const d = authorizeInteraction(id({ commandName, userId: STRANGER }), { owner: OWNER });

    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toMatch(/owner/i);
  });

  it.each(OWNER_ONLY_COMMANDS)("allows /%s to the owner", (commandName) => {
    expect(authorizeInteraction(id({ commandName }), { owner: OWNER }).ok).toBe(true);
  });

  it("leaves an unrestricted command open to anyone the guild check admitted", () => {
    expect(authorizeInteraction(id({ commandName: "help", userId: STRANGER }), { owner: OWNER }).ok).toBe(true);
  });
});

describe("owner-only subcommands", () => {
  it("refuses a mutating subcommand to a non-owner", () => {
    for (const [commandName, subs] of Object.entries(OWNER_ONLY_SUBCOMMANDS)) {
      for (const subcommand of subs) {
        const d = authorizeInteraction(id({ commandName, subcommand, userId: STRANGER }), { owner: OWNER });
        expect(d.ok, `/${commandName} ${subcommand} should be owner-only`).toBe(false);
      }
    }
  });

  it("leaves the read-only subcommands open", () => {
    expect(
      authorizeInteraction(id({ commandName: "memory", subcommand: "show", userId: STRANGER }), { owner: OWNER }).ok,
    ).toBe(true);
    expect(
      authorizeInteraction(id({ commandName: "room", subcommand: "members", userId: STRANGER }), { owner: OWNER }).ok,
    ).toBe(true);
  });

  /**
   * If we could not resolve which subcommand was invoked, we cannot tell a read
   * from a write — so refuse rather than guess in the permissive direction.
   */
  it("refuses when a subcommand-gated command arrives with no subcommand resolved", () => {
    expect(requiresOwner({ commandName: "room", subcommand: undefined })).toBe(true);
  });
});

describe("owner is not configured", () => {
  /**
   * Allowing the command instead would mean the guard does nothing on exactly
   * the deployments that never set an owner.
   */
  it("refuses an owner-only command and names the key to set", () => {
    const d = authorizeInteraction(id({ commandName: "pause" }), {});

    expect(d.ok).toBe(false);
    expect(d.ok === false && d.reason).toMatch(/channels\.discord\.owner/);
  });

  it("still allows unrestricted commands", () => {
    expect(authorizeInteraction(id({ commandName: "help" }), {}).ok).toBe(true);
  });
});

describe("plugin-declared restrictions", () => {
  /** Core enforces the restriction without knowing the plugin's name. */
  it("honours a plugin command that declared owner", () => {
    const restrictions = new Map<string, "owner" | "anyone">([["deploy", "owner"]]);

    expect(
      authorizeInteraction(id({ commandName: "deploy", userId: STRANGER }), {
        owner: OWNER,
        pluginRestrictions: restrictions,
      }).ok,
    ).toBe(false);
    expect(
      authorizeInteraction(id({ commandName: "deploy" }), { owner: OWNER, pluginRestrictions: restrictions }).ok,
    ).toBe(true);
  });

  it("leaves a plugin command that declared anyone open", () => {
    const restrictions = new Map<string, "owner" | "anyone">([["status", "anyone"]]);

    expect(
      authorizeInteraction(id({ commandName: "status", userId: STRANGER }), {
        owner: OWNER,
        pluginRestrictions: restrictions,
      }).ok,
    ).toBe(true);
  });

  /**
   * A plugin may not quietly open a built-in by registering the same name.
   * The registry refuses reserved names, so this can only happen by mistake —
   * but the built-in list must still win when it does. Asserted against the
   * SAME name the plugin claims, or the test proves nothing.
   */
  it("a plugin declaring anyone cannot unlock a built-in of the same name", () => {
    expect(requiresOwner({ commandName: "pause" }, new Map([["pause", "anyone"]]))).toBe(true);
    expect(requiresOwner({ commandName: "memory", subcommand: "set" }, new Map([["memory", "anyone"]]))).toBe(true);
  });
});
