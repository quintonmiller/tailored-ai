/**
 * Changing an agent's body from the page, as its `body` tool would: the
 * `body` record in its own scope, read and written whole with its version so
 * a change the agent made a moment ago is never written over, and taken away
 * once nothing is left in it. A gesture is an `emote` record, made now.
 */
import { BODY_TYPE, type BodyChange, bodyWith, EMOTE_TYPE } from "../avatar/body";

/** What a body wore before that was the body record's (core's `places-body.ts`), taken away once it says. */
const WEAR_TYPE = "wear";

async function failed(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `Couldn't ${what} (${res.status}).`);
}

/** Make a change to an agent's body. Tried again once if someone changed it meanwhile. */
export async function changeBody(agent: string, change: BodyChange, what = "change its body"): Promise<void> {
  const path = `/api/state/${BODY_TYPE}/${encodeURIComponent(agent)}`;
  for (let attempt = 0; ; attempt++) {
    const got = await fetch(path);
    if (!got.ok && got.status !== 404) throw await failed(got, what);
    const record = got.ok ? ((await got.json()) as { data?: Record<string, unknown>; version?: number }) : null;
    const version = record?.version ?? 0;
    const data = bodyWith(record?.data ?? {}, change);
    const res = Object.keys(data).length
      ? await fetch(path, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: `agent:${agent}`, data, expectedVersion: version }),
        })
      : record
        ? await fetch(`${path}?expectedVersion=${version}`, { method: "DELETE" })
        : undefined;
    if (res?.status === 409 && attempt === 0) continue;
    if (res && !res.ok && res.status !== 404) throw await failed(res, what);
    break;
  }
  // What it wears is the body record's now: an old wear record would only bring back what it chose before.
  if ("wear" in change) {
    const old = await fetch(`/api/state/${WEAR_TYPE}/${encodeURIComponent(agent)}`, { method: "DELETE" });
    if (!old.ok && old.status !== 404) throw await failed(old, what);
  }
}

/** Ask an agent's body to make a gesture now, once. */
export async function makeGesture(agent: string, name: string): Promise<void> {
  const res = await fetch(`/api/state/${EMOTE_TYPE}/${encodeURIComponent(agent)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "global", data: { name, at: new Date().toISOString() } }),
  });
  if (!res.ok) throw await failed(res, "make the gesture");
}
