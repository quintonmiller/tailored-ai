import { useEffect, useState } from "react";

/**
 * Forces a re-render every `intervalMs` milliseconds so that
 * relative timestamps ("3m ago") stay accurate.
 */
export function useRelativeTime(intervalMs = 30_000): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return tick;
}
