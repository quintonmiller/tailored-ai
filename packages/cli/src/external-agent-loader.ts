import {
  FileResourceSource,
  GitResourceSource,
  HttpResourceSource,
  NpmResourceSource,
  ResourceLoader,
  TaiRegistrySource,
} from "@tailored-ai/core";

/**
 * Build a ResourceLoader pre-wired with every source the CLI ships with.
 * Mirrors `editor/resolve.ts`'s plugin loader — same sources, same defaults.
 */
export function buildExternalAgentLoader(): ResourceLoader {
  const loader = new ResourceLoader();
  loader.addSource(new FileResourceSource());
  loader.addSource(new HttpResourceSource());
  loader.addSource(new GitResourceSource());
  loader.addSource(new NpmResourceSource());
  loader.addSource(new TaiRegistrySource());
  return loader;
}
