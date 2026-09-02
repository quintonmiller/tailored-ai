/**
 * The store against a real HTTP server that behaves like S3.
 *
 * Not a mocked client: the requests go over `fetch`, signed by the real
 * signer, and the server checks that an Authorization header arrived and
 * stores what it was sent. What that buys over a fake client is the wiring —
 * key layout, content type, 404 handling, and the round trip from
 * `MediaRef.id` back to bytes.
 *
 * What it deliberately does not test is whether AWS accepts the signature.
 * `sigv4.test.ts` pins that against AWS's own signer.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  deleteMediaRow,
  findExpiredMedia,
  getMediaRow,
  initDatabase,
  MediaTooLargeError,
  sniffMedia,
  totalMediaBytes,
  touchMedia,
  upsertMediaRow,
} from "@tailored-ai/core";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { S3MediaStore } from "../store.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7b7d4990000000049454e44ae426082",
  "hex",
);

interface FakeS3 {
  server: Server;
  port: number;
  objects: Map<string, { body: Buffer; contentType?: string }>;
  requests: Array<{ method: string; path: string; authorized: boolean }>;
}

async function fakeS3(): Promise<FakeS3> {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();
  const requests: Array<{ method: string; path: string; authorized: boolean }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const path = req.url ?? "";
      requests.push({ method: req.method ?? "", path, authorized: Boolean(req.headers.authorization) });
      if (!req.headers.authorization) {
        res.writeHead(403).end("<Error><Code>AccessDenied</Code><Message>no signature</Message></Error>");
        return;
      }
      switch (req.method) {
        case "PUT":
          objects.set(path, { body: Buffer.concat(chunks), contentType: req.headers["content-type"] as string });
          res.writeHead(200).end();
          return;
        case "GET": {
          const o = objects.get(path);
          if (!o) {
            res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
            return;
          }
          res.writeHead(200, { "content-type": o.contentType ?? "application/octet-stream" }).end(o.body);
          return;
        }
        case "HEAD":
          res.writeHead(objects.has(path) ? 200 : 404).end();
          return;
        case "DELETE":
          objects.delete(path);
          res.writeHead(204).end();
          return;
        default:
          res.writeHead(405).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, objects, requests };
}

const core = {
  sniffMedia,
  upsertMediaRow,
  getMediaRow,
  deleteMediaRow,
  MediaTooLargeError,
};

describe("S3MediaStore", () => {
  let db: Database.Database;
  let s3: FakeS3;
  let store: S3MediaStore;

  beforeEach(async () => {
    db = initDatabase(":memory:");
    s3 = await fakeS3();
    store = new S3MediaStore({
      db,
      core,
      bucket: "test-bucket",
      region: "us-west-2",
      credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
      // The fake speaks http on localhost; the client builds https URLs from
      // `endpoint`, so this is the one place the test has to lie. `fetch` is
      // pointed at it by overriding the endpoint host.
      endpoint: `http://127.0.0.1:${s3.port}`,
      forcePathStyle: true,
    });
  });
  afterEach(async () => {
    db.close();
    await new Promise<void>((r) => s3.server.close(() => r()));
  });

  it("signs every request", async () => {
    await store.put(PNG, { name: "chart.png" }).catch(() => {});
    expect(s3.requests.length).toBeGreaterThan(0);
    expect(s3.requests.every((r) => r.authorized)).toBe(true);
  });

  it("round-trips bytes through the bucket", async () => {
    const ref = await store.put(PNG, { name: "chart.png", sessionId: "s1" });
    expect(ref.mimeType).toBe("image/png");
    const back = await store.get(ref.id);
    expect(back?.bytes.equals(PNG)).toBe(true);
    expect(back?.ref.name).toBe("chart.png");
  });

  it("lays the key out under the prefix, fanned out by hash", async () => {
    const ref = await store.put(PNG);
    const key = getMediaRow(db, ref.id)?.path ?? "";
    expect(key).toBe(`media/${ref.id.slice(0, 2)}/${ref.id}.png`);
    // Path-style puts the bucket first in the URL.
    expect([...s3.objects.keys()][0]).toBe(`/test-bucket/${key}`);
  });

  it("sends the resolved content type, not the caller's claim", async () => {
    await store.put(PNG, { mimeType: "application/octet-stream" });
    expect([...s3.objects.values()][0].contentType).toBe("image/png");
  });

  it("skips the upload when the bytes are already there", async () => {
    const a = await store.put(PNG, { name: "one.png" });
    s3.requests.length = 0;
    const b = await store.put(PNG, { name: "two.png" });

    expect(b.id).toBe(a.id);
    expect(s3.objects.size).toBe(1);
    // A HEAD to check, and no second PUT.
    expect(s3.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    // The row still refreshes, so retention sees the newer name.
    expect(getMediaRow(db, a.id)?.ref.name).toBe("two.png");
  });

  it("refuses a put over the ceiling before uploading anything", async () => {
    const small = new S3MediaStore({
      db,
      core,
      bucket: "test-bucket",
      region: "us-west-2",
      credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" },
      endpoint: `http://127.0.0.1:${s3.port}`,
      forcePathStyle: true,
      maxBytes: 10,
    });
    await expect(small.put(PNG)).rejects.toThrow(MediaTooLargeError);
    expect(s3.requests).toHaveLength(0);
  });

  it("reports absence when the row survives and the object does not", async () => {
    const ref = await store.put(PNG);
    s3.objects.clear();
    expect(await store.get(ref.id)).toBeUndefined();
    // stat still answers: metadata is ours, bytes are the bucket's.
    expect(await store.stat(ref.id)).toBeDefined();
  });

  it("delete clears both the object and the row", async () => {
    const ref = await store.put(PNG);
    expect(await store.delete(ref.id)).toBe(true);
    expect(s3.objects.size).toBe(0);
    expect(await store.stat(ref.id)).toBeUndefined();
    expect(await store.delete(ref.id)).toBe(false);
  });

  it("participates in retention and the byte total", async () => {
    const ref = await store.put(PNG, { sessionId: "s1" });
    expect(totalMediaBytes(db)).toBe(PNG.byteLength);

    db.prepare("UPDATE media SET last_seen_at = datetime('now', '-90 days') WHERE id = ?").run(ref.id);
    expect(findExpiredMedia(db, 30).map((r) => r.ref.id)).toContain(ref.id);
    touchMedia(db, ref.id);
    expect(findExpiredMedia(db, 30)).toHaveLength(0);
  });

  it("presigns a link for a known id and nothing for an unknown one", async () => {
    const ref = await store.put(PNG);
    const url = store.urlFor(ref.id) ?? "";
    expect(url).toContain("X-Amz-Signature=");
    expect(url).toContain(`${ref.id}.png`);
    expect(store.urlFor("0".repeat(64))).toBeUndefined();
  });

  it("presigns fresh on every call, so a link is never stale", async () => {
    const ref = await store.put(PNG);
    const a = store.urlFor(ref.id);
    await new Promise((r) => setTimeout(r, 1100));
    const b = store.urlFor(ref.id);
    // Different X-Amz-Date, therefore a different signature: nothing cached.
    expect(a).not.toBe(b);
  });

  it("has no local path, because the bytes are not local", () => {
    expect(store.localPathFor).toBeUndefined();
  });
});
