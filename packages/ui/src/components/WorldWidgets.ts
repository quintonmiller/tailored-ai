/**
 * What the widgets on the walls of the 3D world are given (`WorldData` in
 * `avatar/widgets.ts`): fetched here once for every widget in view, each kind
 * only while some widget in the place shows it, and asked again once a
 * minute. What came last stays while a fetch fails, with why beside it, so a
 * widget never goes blank for a moment's trouble.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchProjects } from "../api";
import type { StatsData } from "../avatar/charts";
import type { Prop } from "../avatar/scene";
import {
  type FaceChoice,
  type FaceId,
  type FeedItem,
  faceOf,
  type Loaded,
  type TickerData,
  tickerFromSpeech,
  tickerFromTranscript,
  type WallPhoto,
} from "../avatar/widgets";
import type { MapPlace } from "../lib/wayfinding";

/** How often the widgets ask again for what they show. */
export const WIDGET_REFRESH_MS = 60_000;

/**
 * A JSON endpoint, asked for while `enabled` and again every minute (and
 * whenever `again` changes): what it last sent, and why the last ask failed.
 * Answers that arrive after a newer ask are let go.
 */
export function usePolled<T>(
  url: string | undefined,
  enabled: boolean,
  pick: (body: unknown) => T,
  again?: unknown,
): Loaded<T> {
  const [got, setGot] = useState<Loaded<T>>({});
  const pickRef = useRef(pick);
  pickRef.current = pick;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` changing is how a caller asks again sooner.
  useEffect(() => {
    if (!enabled || !url) return;
    let gone = false;
    let asked = 0;
    const load = async () => {
      const n = ++asked;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
        const data = pickRef.current(await res.json());
        if (!gone && n === asked) setGot({ data });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (!gone && n === asked) setGot((was) => ({ ...was, error }));
      }
    };
    void load();
    const timer = setInterval(load, WIDGET_REFRESH_MS);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [url, enabled, again]);
  // Going to a place with none of these widgets and back starts afresh rather than showing what is long gone.
  useEffect(() => {
    if (!enabled) setGot({});
  }, [enabled]);
  return got;
}

const itemsOf = (body: unknown) => ((body as { items?: FeedItem[] })?.items ?? []) as FeedItem[];
const photosOf = (body: unknown) => ((body as { photos?: WallPhoto[] })?.photos ?? []) as WallPhoto[];
const statsOf = (body: unknown) => body as StatsData;

/** Which widgets the things in a place show, as their faces and what each is of. */
export function facesIn(props: Prop[]): FaceChoice[] {
  return props.flatMap((p) => {
    const choice = faceOf(p);
    return choice ? [choice] : [];
  });
}

/** A ticker's room, from what it was told to show: a room on the map by its name, with or without its `#`. */
export function tickerRoom(arg: string | undefined, places: MapPlace[]): MapPlace | undefined {
  const want = arg?.trim().replace(/^#/, "").toLowerCase();
  if (!want) return undefined;
  return places.find(
    (p) => p.kind === "room" && (p.name.toLowerCase() === want || p.id.toLowerCase() === `room:${want}`),
  );
}

/**
 * The fetched half of what the widgets in a place show: the feed, the
 * numbers behind the charts, the photos, the transcripts of the rooms its
 * tickers show, and the projects' names; each asked for only when a widget
 * in the place needs it. `speech` is what each agent last said, for a
 * ticker of every room; `newest` the time of the latest line in a room, to
 * read its transcript again as soon as someone says something there.
 */
export function useWidgetFeeds(opts: {
  enabled: boolean;
  props: Prop[];
  /** The place on the stage, by id: `room:<ref>` for a meeting room. */
  placeId: string | undefined;
  places: MapPlace[];
  speech: Record<string, { text: string; at: string; room?: string }>;
}): {
  feed: Loaded<FeedItem[]>;
  stats: Loaded<StatsData>;
  photos: Loaded<WallPhoto[]>;
  ticker: (room?: string) => TickerData;
  projects: Record<string, string>;
  /** Which faces are in the place, for the page to know what else to ask for. */
  shows: Set<FaceId>;
} {
  const { enabled, props, placeId, places, speech } = opts;
  const faces = useMemo(() => facesIn(props), [props]);
  const shows = useMemo(() => new Set(faces.map((f) => f.face)), [faces]);
  const feed = usePolled("/api/ext/builtin:activity/feed", enabled && shows.has("feed"), itemsOf);
  const stats = usePolled("/api/ext/builtin:activity/stats?days=14", enabled && shows.has("chart"), statsOf);
  const photos = usePolled("/api/ext/builtin:places/photos", enabled && shows.has("photos"), photosOf);

  // The room a ticker shows with nothing named: the meeting room it hangs in. One named elsewhere: that room.
  const own = placeId?.startsWith("room:") ? placeId : undefined;
  const rooms = useMemo(() => {
    const ids = new Set<string>();
    for (const f of faces) {
      if (f.face !== "ticker") continue;
      const named = tickerRoom(f.arg, places);
      if (named) ids.add(named.id);
      else if (own) ids.add(own);
    }
    return [...ids].sort();
  }, [faces, places, own]);
  // One transcript a place at most is read on a schedule (two tickers of two rooms is rare): the first one's.
  const first = rooms[0];
  const ref = first?.slice("room:".length);
  const newest = useMemo(() => {
    let at = "";
    for (const s of Object.values(speech)) if (s.room === ref && s.at > at) at = s.at;
    return at;
  }, [speech, ref]);
  const transcript = usePolled(
    first ? `/api/ext/builtin:places/transcript/${encodeURIComponent(first)}` : undefined,
    enabled && !!first,
    (body) =>
      body as { name?: string; lines?: { id: string; who: string; agent?: string; text: string; at: string }[] },
    newest,
  );
  const ticker = useMemo(() => {
    const read: TickerData | undefined = first
      ? {
          title: `#${transcript.data?.name ?? places.find((p) => p.id === first)?.name ?? ref ?? "room"}`,
          lines: tickerFromTranscript(transcript.data?.lines ?? []),
          ...(transcript.error ? { error: transcript.error } : {}),
        }
      : undefined;
    return (arg?: string): TickerData => {
      const named = tickerRoom(arg, places);
      const id = named?.id ?? (arg ? undefined : own);
      if (id && id === first && read) return read;
      if (id) {
        // A room this place doesn't read on a schedule: what each agent last said there.
        const name = named?.name ?? places.find((p) => p.id === id)?.name ?? id.slice("room:".length);
        return { title: `#${name}`, lines: tickerFromSpeech(speech, id.slice("room:".length)) };
      }
      return { title: arg ? `No room called “${arg}”` : "Every room", lines: arg ? [] : tickerFromSpeech(speech) };
    };
  }, [first, ref, transcript, places, own, speech]);

  const [projects, setProjects] = useState<Record<string, string>>({});
  const boards = shows.has("tasks");
  useEffect(() => {
    if (!enabled || !boards) return;
    let gone = false;
    fetchProjects({ limit: 200 })
      .then((res) => {
        if (!gone) setProjects(Object.fromEntries(res.projects.map((p) => [p.id, p.title])));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [enabled, boards]);

  // The same object while nothing in it changed: the page draws often, and every widget is drawn again for a new one.
  return useMemo(
    () => ({ feed, stats, photos, ticker, projects, shows }),
    [feed, stats, photos, ticker, projects, shows],
  );
}

/**
 * Whose things the widgets in a place show: a home's owner's; a meeting
 * room's members', wherever their bodies are; whoever is there in a shared
 * place; and everyone's in the lobby, or anywhere nobody is.
 */
export function whoseIn(placeId: string | undefined, here: string[], places: MapPlace[]): string[] | undefined {
  if (!placeId || placeId === "lobby") return undefined;
  if (placeId.startsWith("home:")) return [placeId.slice("home:".length)];
  const members = placeId.startsWith("room:") ? places.find((p) => p.id === placeId)?.members : undefined;
  if (members?.length) return members;
  return here.length ? here : undefined;
}
