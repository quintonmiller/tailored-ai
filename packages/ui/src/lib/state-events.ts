/**
 * One stream of world-state changes for everything on the page.
 *
 * Each bound card wants to hear when its record changes, and a browser holds
 * only a handful of connections per origin, so cards share one EventSource,
 * opened for the first listener and closed after the last.
 */
import { fetchStateTypes, type StateChangeInfo } from "../api";

type Listener = (change: StateChangeInfo) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

export function subscribeStateChanges(listener: Listener): () => void {
  listeners.add(listener);
  if (!source) {
    source = new EventSource("/api/state/events");
    source.addEventListener("change", (ev) => {
      let change: StateChangeInfo;
      try {
        change = JSON.parse((ev as MessageEvent).data) as StateChangeInfo;
      } catch {
        return;
      }
      for (const l of listeners) l(change);
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
    }
  };
}

let titles: Promise<Map<string, string | undefined>> | null = null;

/** The field that names a type's records, fetched once per page load. */
export function stateTitleField(type: string): Promise<string | undefined> {
  titles ??= fetchStateTypes()
    .then((res) => new Map(res.types.map((t) => [t.name, t.title])))
    .catch(() => {
      titles = null;
      return new Map();
    });
  return titles.then((m) => m.get(type));
}
