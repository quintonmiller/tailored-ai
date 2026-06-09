/**
 * Repo backend registry + resolver tests — Slice 4 of the platform vision.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../../config.js";
import { createRepoBackend, registerRepoBackendFactory, repoBackendFactoryRegistry } from "../factory.js";
import { GhRepoBackend } from "../github.js";
import type { RepoBackend } from "../interface.js";

function cfg(repo?: AgentConfig["repo"]): AgentConfig {
  return { repo } as AgentConfig;
}

afterEach(() => {
  repoBackendFactoryRegistry.unregister("custom");
});

describe("createRepoBackend", () => {
  it("returns undefined when no backend is configured (opt-in — preserves today's behavior)", () => {
    expect(createRepoBackend(cfg())).toBeUndefined();
    expect(createRepoBackend(cfg({ backend: "none" }))).toBeUndefined();
  });

  it("builds the default gh backend for backend: github", () => {
    const be = createRepoBackend(cfg({ backend: "github" }));
    expect(be).toBeInstanceOf(GhRepoBackend);
    expect(be?.name).toBe("github");
  });

  it("throws a helpful error for an unknown backend", () => {
    expect(() => createRepoBackend(cfg({ backend: "gitlab" as "github" }))).toThrow(
      /Unsupported repo.backend "gitlab"/,
    );
  });

  it("resolves a custom backend registered via registerRepoBackendFactory", () => {
    const fake: RepoBackend = {
      name: "custom",
      pushBranch: async () => ({ remote: "origin", branch: "b", pushed: true, upToDate: false }),
      openProposal: async () => ({ id: "1", branch: "b", base: "main", title: "", state: "open", approvedBy: [] }),
      getProposalState: async () => undefined,
      mergeProposal: async () => ({ id: "1", branch: "b", base: "main", title: "", state: "merged", approvedBy: [] }),
      closeProposal: async () => {},
    };
    registerRepoBackendFactory("custom", () => fake);
    const be = createRepoBackend(cfg({ backend: "custom" as "github" }));
    expect(be).toBe(fake);
  });

  it("registers github as a built-in", () => {
    expect(repoBackendFactoryRegistry.has("github")).toBe(true);
    expect(repoBackendFactoryRegistry.list()).toContain("github");
  });
});
