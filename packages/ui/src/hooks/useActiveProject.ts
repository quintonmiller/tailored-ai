import { useEffect, useState } from "react";
import { getActiveProjectId } from "../api";

/**
 * Subscribe to the UI's active-project state. Returns the current id (or null
 * for "all"/"global"). Components that read this in their effect deps will
 * re-fetch when the switcher changes.
 */
export function useActiveProject(): string | null {
  const [id, setId] = useState<string | null>(getActiveProjectId());
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<string | null>).detail;
      setId(detail ?? null);
    };
    window.addEventListener("tai:active-project-change", onChange);
    return () => window.removeEventListener("tai:active-project-change", onChange);
  }, []);
  return id;
}
