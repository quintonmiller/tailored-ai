import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

/**
 * Long-lived responses, and ending them when the server stops.
 *
 * `server.close()` waits for every connection to finish, and an event stream
 * never finishes by itself. One browser tab with the world open holds
 * `/api/state/events`, and that alone kept `tai stop` waiting until the
 * service gave up and killed the process 30 seconds later, with the shutdown
 * hooks cut off. So every stream the server opens goes through
 * {@link OpenStreams.sse}, and stopping the server ({@link stopServer}) ends
 * them first: cleanly, so a browser sees its stream close and tries again
 * later, rather than a reset.
 */
export class OpenStreams {
  private readonly open = new Set<SSEStreamingApi>();
  private readonly stopping = new AbortController();

  /** How many are open now. */
  get size(): number {
    return this.open.size;
  }

  /**
   * `streamSSE`, ended when the server stops. `ended` aborts when the client
   * goes away or the server stops, whichever comes first: what a stream that
   * waits for its end waits on. Ended, the response finishes even while
   * `run` is still busy, and anything it writes after that goes nowhere.
   */
  sse(c: Context, run: (stream: SSEStreamingApi, ended: AbortSignal) => Promise<void>): Response {
    return streamSSE(c, async (stream) => {
      const ended = AbortSignal.any([c.req.raw.signal, this.stopping.signal]);
      if (ended.aborted) return;
      const end = () => stream.abort();
      ended.addEventListener("abort", end, { once: true });
      this.open.add(stream);
      try {
        await run(stream, ended);
      } finally {
        ended.removeEventListener("abort", end);
        this.open.delete(stream);
      }
    });
  }

  /** End every open stream, and any opened from now on as it opens. */
  endAll(): void {
    this.stopping.abort();
  }
}

/** Resolves once `signal` aborts: a stream's wait for its end. */
export function untilEnded(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The parts of a Node HTTP server that stopping it uses. */
export interface Stoppable {
  close(callback: () => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

/** How often, while the server stops, connections that have gone quiet are let go. */
const IDLE_SWEEP_MS = 50;

/**
 * Stop a server that has streams open. It stops taking connections, every
 * stream ends, and each connection is closed as soon as nothing is being
 * answered on it: a browser keeps its connection alive after a stream ends,
 * and `close()` lets go only of those idle when it is called, so the rest
 * are let go as they go quiet. A request still being answered after
 * `graceMs` (a reply half written, a plugin's long poll) has its connection
 * closed under it. Resolves when every connection is gone.
 */
export function stopServer(server: Stoppable, streams: OpenStreams, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const sweep = setInterval(() => server.closeIdleConnections?.(), IDLE_SWEEP_MS);
    const cut = setTimeout(() => server.closeAllConnections?.(), graceMs);
    server.close(() => {
      clearInterval(sweep);
      clearTimeout(cut);
      resolve();
    });
    streams.endAll();
    server.closeIdleConnections?.();
  });
}
