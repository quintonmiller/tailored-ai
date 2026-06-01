import {
  FileResourceSource,
  GitResourceSource,
  HttpResourceSource,
  NpmResourceSource,
  ResourceLoader,
  TaiRegistrySource,
} from "@tailored-ai/core";
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

export async function resolveOnePlugin(uri: string): Promise<ResolvedPlugin> {
  const loader = buildLoader();
  try {
    const res = await loader.load(uri);
    return { uri, manifestId: res.manifest.id, version: res.manifest.version };
  } catch (err) {
    return { uri, resolveError: (err as Error).message };
  }
}
