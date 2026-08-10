import type { AgentConfig } from "../config.js";
import { Registry } from "../registry.js";

/**
 * Clock and timezone source supplied by core or a plugin.
 *
 * `now()` returns an absolute instant. `timeZone()` optionally supplies the
 * provider's preferred IANA timezone; an explicit `time.timezone` setting
 * always wins over it.
 */
export interface TimeProvider {
  now(): Date;
  timeZone?(): string | undefined;
}

export type TimeProviderFactory = (config: AgentConfig) => TimeProvider;

/** The runtime-resolved view consumed by tools and background workers. */
export interface ResolvedTimeProvider {
  readonly id: string;
  readonly timeZoneSource: "config" | "provider" | "system";
  now(): Date;
  timeZone(): string;
}

export const timeProviderFactoryRegistry = new Registry<TimeProviderFactory>("time-provider-factory");

export function registerTimeProviderFactory(id: string, factory: TimeProviderFactory): void {
  timeProviderFactoryRegistry.register(id, factory);
}

export function systemTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!resolved) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: resolved }).format(0);
    return resolved;
  } catch {
    // Node reports `Etc/Unknown` when TZ is explicitly empty. It cannot be
    // passed back into Intl, so keep the system clock usable and diagnose UTC.
    return "UTC";
  }
}

export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
  } catch {
    throw new Error(`Invalid time.timezone "${timeZone}". Use an IANA timezone such as "America/Los_Angeles".`);
  }
}

export function resolveTimeProvider(config: AgentConfig): ResolvedTimeProvider {
  const configuredProvider = config.time?.provider;
  if (configuredProvider !== undefined && typeof configuredProvider !== "string") {
    throw new Error("Invalid time.provider: expected a string.");
  }
  if (config.time?.timezone !== undefined && typeof config.time.timezone !== "string") {
    throw new Error("Invalid time.timezone: expected an IANA timezone string.");
  }
  const id = configuredProvider || "system";
  const factory = timeProviderFactoryRegistry.get(id);
  if (!factory) {
    const known = timeProviderFactoryRegistry.list().join(", ") || "(none)";
    throw new Error(`No time provider factory registered for "${id}". Known: ${known}.`);
  }

  const provider = factory(config);
  if (!provider || typeof provider.now !== "function") {
    throw new Error(`Time provider "${id}" must implement now().`);
  }
  const configuredZone = config.time?.timezone?.trim();
  const rawProviderZone = provider.timeZone?.();
  if (rawProviderZone !== undefined && typeof rawProviderZone !== "string") {
    throw new Error(`Time provider "${id}" returned a non-string timezone.`);
  }
  const providerZone = rawProviderZone?.trim();
  const timeZone = configuredZone || providerZone || systemTimeZone();
  assertValidTimeZone(timeZone);

  return {
    id,
    timeZoneSource: configuredZone ? "config" : providerZone && id !== "system" ? "provider" : "system",
    now(): Date {
      const value = provider.now();
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new Error(`Time provider "${id}" returned an invalid date.`);
      }
      // Do not let callers mutate a provider-owned Date instance.
      return new Date(value.getTime());
    },
    timeZone: () => timeZone,
  };
}

/**
 * Compatibility bridge for lightweight runtime stubs used by embedders and
 * tests. Real AgentRuntime instances always own a resolved provider.
 */
export function runtimeTimeProvider(runtime: { getTimeProvider?: () => ResolvedTimeProvider }): ResolvedTimeProvider {
  const owned = runtime.getTimeProvider?.();
  if (owned) return owned;
  const timeZone = systemTimeZone();
  return {
    id: "system",
    timeZoneSource: "system",
    now: () => new Date(),
    timeZone: () => timeZone,
  };
}

registerTimeProviderFactory("system", () => ({
  now: () => new Date(),
  timeZone: systemTimeZone,
}));
