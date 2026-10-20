/**
 * The colour each agent chose for its body, for the dot by its name wherever
 * the page lists it: the chat, the needs list, a place's who-is-here, the
 * names on boards and calendars. One read of the `body` records and one
 * listener on the change stream, shared by every dot showing, opened for the
 * first and closed after the last, as the stream itself is.
 */
import { useSyncExternalStore } from "react";
import { BODY_TYPE, dotColor } from "../avatar/body";
import { subscribeStateChanges } from "./state-events";

/** "#rrggbb" by agent, for the agents that chose a colour. */
type Chosen = Readonly<Record<string, string>>;

const NONE: Chosen = {};
let chosen: Chosen = NONE;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

const colorIn = (data: unknown): string | undefined => {
  const color = (data as { color?: unknown } | null | undefined)?.color;
  return typeof color === "string" ? color : undefined;
};

function set(next: Chosen) {
  chosen = next;
  for (const l of listeners) l();
}

/** Start keeping the colours: what the server has, then each change as it comes. */
function start(): () => void {
  let gone = false;
  // Changes heard while the first read is out are newer: they win over it.
  const heard = new Map<string, string | undefined>();
  let off = () => {};
  try {
    off = subscribeStateChanges((change) => {
      if (change.type !== BODY_TYPE) return;
      const color = change.op === "delete" ? undefined : colorIn(change.after);
      heard.set(change.id, color);
      if ((chosen[change.id] ?? undefined) === color) return;
      const next = { ...chosen };
      if (color) next[change.id] = color;
      else delete next[change.id];
      set(next);
    });
  } catch {
    // No change stream here: the colours as they were read.
  }
  fetch(`/api/state/${BODY_TYPE}?limit=500`)
    .then((res) => (res.ok ? (res.json() as Promise<{ records?: { id: string; data: unknown }[] }>) : null))
    .then((body) => {
      if (gone || !body?.records) return;
      const next: Record<string, string> = {};
      for (const r of body.records) {
        const color = heard.has(r.id) ? heard.get(r.id) : colorIn(r.data);
        if (color) next[r.id] = color;
      }
      for (const [id, color] of heard) if (color) next[id] = color;
      set(next);
    })
    .catch(() => {});
  return () => {
    gone = true;
    off();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stop) stop = start();
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    stop?.();
    stop = undefined;
    chosen = NONE;
  };
}

const snapshot = () => chosen;

/**
 * The colour of the dot by an agent's name: the one its body chose, or the
 * one its name gives it, kept current as either changes.
 */
export function useAgentColor(): (agent: string) => string {
  const colors = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (agent) => dotColor(agent, colors[agent]);
}

/** The colours agents chose for their bodies, by agent, kept current: those that chose none aren't in it. */
export function useChosenColors(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The colour an agent chose for its body, if it chose one, kept current. */
export function useChosenColor(agent: string): string | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot)[agent];
}
