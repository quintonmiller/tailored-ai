import {
  FileResourceSource,
  GitResourceSource,
  HttpResourceSource,
  NpmResourceSource,
  ResourceLoader,
  TaiRegistrySource,
} from "@tailored-ai/core";
import { PluginManager } from "../plugins/manager.js";
import type { ResolvedPlugin } from "./types.js";

/** Build a loader with the same sources `tai resources install` uses. */
function buildLoader(): ResourceLoader {
  const loader = new ResourceLoader();
  loader.addSource(new FileResourceSource());
  loader.addSource(new HttpResourceSource());
  loader.addSource(new GitResourceSource());
  loader.addSource(new NpmResourceSource());
  loader.addSource(new TaiRegistrySource());
  return loader;
}

/**
 * Resolve a plugin URI's manifest AND install the package into the TAI
 * plugin home, so that the runtime's importer (see PluginManager.buildImporter)
 * can find it at load time. Either step failing leaves the plugin marked
 * with `resolveError` so the editor surfaces the failure.
 *
 * The plugin home is keyed by `homeDir` — same value the rest of the editor
 * draft carries — so the install lands wherever this TAI install is rooted.
 */
export async function resolveOnePlugin(uri: string, homeDir: string): Promise<ResolvedPlugin> {
  const loader = buildLoader();
  let manifestId: string | undefined;
  let version: string | undefined;
  try {
    const res = await loader.load(uri);
    manifestId = res.manifest.id;
    version = res.manifest.version;
  } catch (err) {
    return { uri, resolveError: (err as Error).message };
  }

  const manager = new PluginManager(homeDir);
  const installRes = manager.install([uri]);
  if (!installRes.ok) {
    return {
      uri,
      manifestId,
      version,
      resolveError: `install failed${installRes.stderr ? `: ${installRes.stderr.trim()}` : ""}`,
    };
  }
  return { uri, manifestId, version };
}
