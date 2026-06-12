/**
 * Minimal server-sent-events parser for the Messages API streaming response.
 *
 * Vendored from core's `providers/sse.ts`, which is not a public export yet —
 * #234 tracks exporting it and deleting this copy. Yields one message per
 * blank-line-terminated event block; multiple `data:` lines within a block
 * are joined with newlines per the SSE spec. Comments (`:` lines) and
 * unknown fields are ignored.
 */

export interface SseMessage {
  event?: string;
  data: string;
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SseMessage | undefined => {
    if (data.length === 0) {
      event = undefined;
      return undefined;
    }
    const msg: SseMessage = { event, data: data.join("\n") };
    event = undefined;
    data = [];
    return msg;
  };

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");

      if (line === "") {
        const msg = flush();
        if (msg) yield msg;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trimStart();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
      // ignore comments (":") and other fields (id:, retry:)
    }
  }
  const msg = flush();
  if (msg) yield msg;
}
