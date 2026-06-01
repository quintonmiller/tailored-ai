import type { AgentConfig } from "./config.js";
import { parseAgentData } from "./resources/agent.js";
import type { Resource } from "./resources/interface.js";
import type { ResourceLoader } from "./resources/loader.js";
import type { AgentRuntime } from "./runtime.js";

export interface LoadedExternalAgent {
  uri: string;
  ok: boolean;
  /** Agent id from the loaded manifest, when the load succeeded. */
  agentId?: string;
  error?: string;
}

/**
 * Resolve every URI in `config.externalAgents`, parse each manifest into an
 * `AgentDefinition`, and register the result into `runtime.getAgentRegistry()`.
 *
 * URI schemes match `ResourceLoader.load` — `file`, `https`, `git`, `npm`,
 * `tai-registry`, etc. The caller is responsible for handing in a loader with
 * the source set it needs; the bare ResourceLoader default only has
 * `file://` + `agent://`. The CLI passes a loader pre-wired with the full
 * source list (see `editor/resolve.ts`).
 *
 * Failures from one URI do not block the others — each fetch is wrapped in
 * try/catch, logged, and the next URI is attempted. Mirrors `loadPlugins`.
 */
export async function loadExternalAgents(
  config: AgentConfig,
  runtime: AgentRuntime,
  loader: ResourceLoader,
): Promise<LoadedExternalAgent[]> {
  const uris = config.externalAgents ?? [];
  if (uris.length === 0) return [];

  const registry = runtime.getAgentRegistry();
  const results: LoadedExternalAgent[] = [];
  for (const uri of uris) {
    if (typeof uri !== "string" || !uri.trim()) {
      console.warn(`[external-agents] skipping invalid entry: ${JSON.stringify(uri)}`);
      results.push({ uri: String(uri), ok: false, error: "invalid entry shape" });
      continue;
    }
    try {
      const res = await loader.load(uri);
      if (res.manifest.kind !== "agent") {
        throw new Error(`expected manifest.kind="agent", got "${res.manifest.kind}"`);
      }
      const definition = parseAgentData(res.manifest);
      const resource: Resource = {
        manifest: res.manifest,
        origin: res.origin,
        body: { manifest: res.manifest, definition },
      };
      registry.register(resource as never);
      console.log(`[external-agents] loaded ${uri} as ${res.manifest.id}`);
      results.push({ uri, ok: true, agentId: res.manifest.id });
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[external-agents] failed to load ${uri}: ${message} — continuing without it`);
      results.push({ uri, ok: false, error: message });
    }
  }
  return results;
}
