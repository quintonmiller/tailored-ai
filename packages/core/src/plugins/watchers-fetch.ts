/**
 * The `fetch` a watcher check is handed as `ctx.fetch`. The runner builds one
 * per check.
 *
 * It reaches the network on the terms `web_fetch` does: the same egress
 * policy (`security.egress`), the same refusal while a browser-mediator
 * session limits outbound hosts, the same timeout and the same user agent.
 * On top of those, because a watch runs on its own with nobody reading:
 *
 * - every redirect is followed by hand and checked against the policy, hop by
 *   hop, rather than only the address a watch was given. A hop to another
 *   origin drops the credentials a kind sent (`Authorization`, `Cookie`,
 *   `Proxy-Authorization`), as the platform `fetch` does;
 * - a check reaches one host at most once per `spacingMs` after the last
 *   check that reached it, across every watch and every load of the plugin, so
 *   twenty watches on one site arrive in single file rather than at once. The
 *   wait is per check, not per request: a kind that asks one host twice in
 *   one check waits its turn for the first request only;
 * - an answer bigger than `maxBytes` is refused rather than read.
 */
import { EgressDeniedError, type EgressPolicy } from "../security/egress-policy.js";
import { WEB_FETCH_TIMEOUT_MS, WEB_FETCH_USER_AGENT } from "../tools/web-fetch.js";

/** Redirects followed before giving up. */
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** Statuses whose answer has no body, which `new Response` refuses one for. */
const NO_BODY = new Set([101, 204, 205, 304]);
/** What a redirect to another origin doesn't carry on, as the fetch standard has it. */
const CREDENTIALS = ["authorization", "cookie", "proxy-authorization"];

export interface WatchFetchOptions {
  /** The egress policy, read on every request so a reload's `security.egress` applies at once. */
  policy: () => EgressPolicy | undefined;
  /** The least time between two checks reaching one host. */
  spacingMs: number;
  /** The longest an answer may be, in bytes. */
  maxBytes: number;
  /** How long to wait for each answer, body included. `web_fetch`'s by default. */
  timeoutMs?: number;
  now?: () => number;
  /** The fetch underneath, the global one by default. Tests hand in their own. */
  fetch?: typeof fetch;
}

/**
 * When each host may next be asked. Kept at module level so a reload, which
 * builds a new runner, doesn't forget a request the old one just made.
 */
const nextTurn = new Map<string, number>();

/** For tests: forget every host's spacing. */
export function resetHostSpacing(): void {
  nextTurn.clear();
}

/** A `fetch` for one check. Build another for the next check: the hosts it has waited for are its own. */
export function watchFetch(opts: WatchFetchOptions): typeof fetch {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const base = opts.fetch ?? fetch;
  /** Hosts this check has had its turn at. */
  const admitted = new Set<string>();

  async function admit(url: string, signal: AbortSignal | undefined): Promise<void> {
    await permitted(url, opts.policy());
    const host = new URL(url).host;
    if (admitted.has(host)) return;
    admitted.add(host);
    await waitTurn(host, opts.spacingMs, now, signal);
  }

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const signal = init?.signal ?? undefined;
    const headers = new Headers(init?.headers);
    if (!headers.has("user-agent")) headers.set("User-Agent", WEB_FETCH_USER_AGENT);
    if (!headers.has("accept")) headers.set("Accept", "text/html, application/json, text/plain, */*");

    let method = init?.method ?? "GET";
    let body = init?.body;
    for (let hop = 0; ; hop++) {
      await admit(url, signal);
      // Each answer gets the timeout to itself; the wait for a host's turn isn't counted against it.
      const answer = await withTimeout(timeoutMs, signal, async (combined) => {
        const sent = new Headers(headers);
        const res = await base(url, { ...init, method, body, headers: sent, redirect: "manual", signal: combined });
        const location = res.headers.get("location");
        if (REDIRECTS.has(res.status) && location) {
          await res.body?.cancel().catch(() => {});
          return { status: res.status, location };
        }
        return capped(res, opts.maxBytes, url);
      });
      if (answer instanceof Response) return answer;
      if (hop >= MAX_REDIRECTS) throw new Error(`${new URL(url).host} redirected more than ${MAX_REDIRECTS} times.`);
      const next = new URL(answer.location, url).href;
      if (new URL(next).origin !== new URL(url).origin) for (const name of CREDENTIALS) headers.delete(name);
      // A 303, and a 301 or 302 answering anything but a GET, are followed with a GET, as browsers do.
      if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && method !== "GET")) {
        method = "GET";
        body = undefined;
      }
      url = next;
    }
  }) as typeof fetch;
}

/** Throws, in a sentence, when the policy or a browser-mediator session keeps this address out of reach. */
async function permitted(url: string, policy: EgressPolicy | undefined): Promise<void> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`"${url}" is not a web address.`);
  }
  // Loaded when used, as web_fetch loads it.
  const { isHostAllowed, hasActiveMediatorSession } = await import("../browser/egress-policy.js");
  if (hasActiveMediatorSession() && !isHostAllowed(host)) {
    throw new Error(`${host} is outside the allow-list of the browser-mediator session that is open now.`);
  }
  if (!policy) return;
  try {
    await policy.check(url);
  } catch (err) {
    if (err instanceof EgressDeniedError) throw new Error(`${host} is not reachable from here: ${err.reason}.`);
    throw err;
  }
}

/**
 * Wait until `host` may be asked again, and book the turn after. The booking
 * happens before the wait, so two checks for one host queue rather than both
 * waking at the same moment.
 */
async function waitTurn(host: string, spacingMs: number, now: () => number, signal?: AbortSignal): Promise<void> {
  const t = now();
  const at = Math.max(t, nextTurn.get(host) ?? 0);
  nextTurn.set(host, at + spacingMs);
  if (at > t) await sleep(at - t, signal);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", stop);
      resolve();
    }
    function stop() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Run `work` with a signal aborted after `ms` or when `outer` is. The listener
 * on `outer` comes off afterwards: the runner's signal lives for the whole
 * check, and one listener per request would otherwise pile up on it.
 */
async function withTimeout<T>(ms: number, outer: AbortSignal | undefined, work: (s: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`no answer within ${Math.round(ms / 1000)}s`)), ms);
  const relay = () => controller.abort(outer?.reason);
  if (outer?.aborted) relay();
  else outer?.addEventListener("abort", relay, { once: true });
  try {
    return await work(controller.signal);
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", relay);
  }
}

/** The answer, read whole as long as it stays under `max` bytes, and refused once it doesn't. */
async function capped(res: Response, max: number, url: string): Promise<Response> {
  const init = { status: res.status, statusText: res.statusText, headers: res.headers };
  if (NO_BODY.has(res.status) || !res.body) return new Response(null, init);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body.cancel().catch(() => {});
    throw new Error(`${new URL(url).host} sent ${sizeWords(declared)}, over the ${sizeWords(max)} a watch reads.`);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error(`${new URL(url).host} sent more than the ${sizeWords(max)} a watch reads.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new Response(bytes, init);
}

function sizeWords(bytes: number): string {
  return bytes >= 1_048_576 ? `${Math.round(bytes / 1_048_576)} MB` : `${Math.round(bytes / 1024)} KB`;
}
