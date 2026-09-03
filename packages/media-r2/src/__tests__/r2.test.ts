/**
 * R2's three fixed answers, and the one thing it has that S3 does not.
 *
 * This package exists because endpoint shape, signing region and addressing
 * style are not discoverable and a wrong one fails with `SignatureDoesNotMatch`,
 * which names none of them. So those are what is pinned here — not the S3
 * mechanics underneath, which `@tailored-ai/media-s3` already covers.
 *
 * The store is driven against a real HTTP server that checks for a signature,
 * because the last two bugs in this family were both invisible to unit tests:
 * a registration nobody read, and a presigned URL every real server rejected.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  deleteMediaRow,
  getMediaRow,
  initDatabase,
  MediaTooLargeError,
  sniffMedia,
  upsertMediaRow,
} from "@tailored-ai/core";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin, { meta, R2MediaStore, r2Endpoint, validateConfig } from "../index.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7b7d4990000000049454e44ae426082",
  "hex",
);

const core = { sniffMedia, upsertMediaRow, getMediaRow, deleteMediaRow, MediaTooLargeError };

interface Fake {
  server: Server;
  port: number;
  objects: Map<string, Buffer>;
  seen: Array<{ method: string; path: string; host: string; signed: boolean }>;
}

async function fakeR2(): Promise<Fake> {
  const objects = new Map<string, Buffer>();
  const seen: Array<{ method: string; path: string; host: string; signed: boolean }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const path = req.url ?? "";
      seen.push({
        method: req.method ?? "",
        path,
        host: String(req.headers.host ?? ""),
        signed: Boolean(req.headers.authorization) || path.includes("X-Amz-Signature"),
      });
      if (!req.headers.authorization) {
        res.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
        return;
      }
      if (req.method === "PUT") {
        objects.set(path, Buffer.concat(chunks));
        res.writeHead(200).end();
        return;
      }
      if (req.method === "HEAD") {
        res.writeHead(objects.has(path) ? 200 : 404).end();
        return;
      }
      if (req.method === "GET") {
        const o = objects.get(path);
        o ? res.writeHead(200).end(o) : res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      if (req.method === "DELETE") {
        objects.delete(path);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, objects, seen };
}

describe("r2Endpoint", () => {
  it("is the account endpoint Cloudflare documents", () => {
    expect(r2Endpoint("abc123")).toBe("https://abc123.r2.cloudflarestorage.com");
  });
});

describe("the three settings this package exists to get right", () => {
  const opts = {
    db: null as unknown as Database.Database,
    core,
    bucket: "tai-media",
    accountId: "abc123",
    accessKeyId: "k",
    secretAccessKey: "s",
  };

  it("signs against `auto`, whatever a region setting says", () => {
    const store = new R2MediaStore({ ...opts, db: initDatabase(":memory:") });
    // Reach the presigned URL for a key we know exists in the row table.
    const db = (store as unknown as { db: Database.Database }).db;
    upsertMediaRow(db, {
      ref: { id: "a".repeat(64), mimeType: "image/png", bytes: 1 },
      path: "media/aa/aaa.png",
      sessionId: null,
    });
    const url = store.urlFor("a".repeat(64)) ?? "";
    expect(url).toContain("%2Fauto%2Fs3%2Faws4_request");
    db.close();
  });

  it("addresses the bucket path-style under the account endpoint", () => {
    const db = initDatabase(":memory:");
    const store = new R2MediaStore({ ...opts, db });
    upsertMediaRow(db, {
      ref: { id: "b".repeat(64), mimeType: "audio/wav", bytes: 1 },
      path: "media/bb/bbb.wav",
      sessionId: null,
    });
    const url = new URL(store.urlFor("b".repeat(64)) ?? "");
    expect(url.host).toBe("abc123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/tai-media/media/bb/bbb.wav");
    db.close();
  });

  it("refuses to construct without an account id or an endpoint", () => {
    const db = initDatabase(":memory:");
    expect(() => new R2MediaStore({ ...opts, db, accountId: undefined })).toThrow(/accountId is required/);
    db.close();
  });
});

describe("against a live S3-compatible server", () => {
  let db: Database.Database;
  let fake: Fake;
  let store: R2MediaStore;

  beforeEach(async () => {
    db = initDatabase(":memory:");
    fake = await fakeR2();
    store = new R2MediaStore({
      db,
      core,
      bucket: "tai-media",
      endpoint: `http://127.0.0.1:${fake.port}`,
      accessKeyId: "k",
      secretAccessKey: "s",
    });
  });
  afterEach(async () => {
    db.close();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("round-trips through the bucket, signing every request", async () => {
    const ref = await store.put(PNG, { name: "chart.png" });
    expect((await store.get(ref.id))?.bytes.equals(PNG)).toBe(true);
    expect(fake.seen.every((s) => s.signed)).toBe(true);
    expect([...fake.objects.keys()][0]).toBe(`/tai-media/media/${ref.id.slice(0, 2)}/${ref.id}.png`);
  });

  it("delete clears the object and the row", async () => {
    const ref = await store.put(PNG);
    expect(await store.delete(ref.id)).toBe(true);
    expect(fake.objects.size).toBe(0);
    expect(await store.stat(ref.id)).toBeUndefined();
  });
});

describe("public bucket links", () => {
  it("returns a permanent public URL when a domain is configured", async () => {
    const db = initDatabase(":memory:");
    const fake = await fakeR2();
    const store = new R2MediaStore({
      db,
      core,
      bucket: "tai-media",
      endpoint: `http://127.0.0.1:${fake.port}`,
      accessKeyId: "k",
      secretAccessKey: "s",
      publicBaseUrl: "https://media.example.com/",
    });
    const ref = await store.put(PNG, { name: "chart.png" });
    const url = store.urlFor(ref.id) ?? "";
    expect(url).toBe(`https://media.example.com/media/${ref.id.slice(0, 2)}/${ref.id}.png`);
    // The point of a public URL is that it does not expire.
    expect(url).not.toContain("X-Amz-Signature");
    db.close();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("falls back to presigned when no domain is configured", async () => {
    const db = initDatabase(":memory:");
    const fake = await fakeR2();
    const store = new R2MediaStore({
      db,
      core,
      bucket: "tai-media",
      endpoint: `http://127.0.0.1:${fake.port}`,
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    const ref = await store.put(PNG);
    expect(store.urlFor(ref.id)).toContain("X-Amz-Signature=");
    db.close();
    await new Promise<void>((r) => fake.server.close(() => r()));
  });
});

describe("registration", () => {
  function fakeCtx() {
    const registered: Array<{ registry: string; id: string }> = [];
    const disposed: string[] = [];
    const view = (registry: string) => ({
      register: (id: string) => {
        registered.push({ registry, id });
        return () => disposed.push(`${registry}:${id}`);
      },
    });
    return { registered, disposed, ctx: { mediaStores: view("mediaStores") } as never };
  }

  it("registers through ctx, not a module-level registry", () => {
    const { ctx, registered } = fakeCtx();
    plugin(ctx);
    expect(registered).toEqual([{ registry: "mediaStores", id: "r2" }]);
  });

  it("returns a disposer", () => {
    const { ctx, disposed } = fakeCtx();
    (plugin(ctx) as () => void)();
    expect(disposed).toEqual(["mediaStores:r2"]);
  });

  it("declares what it registers", () => {
    expect(meta.registers).toEqual([{ kind: "media-store", id: "r2", configKey: "media" }]);
  });
});

describe("validateConfig", () => {
  const ok = { store: "r2", options: { accountId: "a", bucket: "b", accessKeyId: "k", secretAccessKey: "s" } };

  it("is quiet on a good config", () => {
    expect(validateConfig({ media: ok } as never)).toEqual([]);
  });

  it("says nothing at all when another store is selected", () => {
    expect(validateConfig({ media: { store: "disk" } } as never)).toEqual([]);
  });

  it("names each missing required field", () => {
    const w = validateConfig({ media: { store: "r2", options: {} } } as never).join(" ");
    expect(w).toMatch(/bucket is empty/);
    expect(w).toMatch(/accountId is empty/);
    expect(w).toMatch(/no credentials resolved/);
  });

  it("says a region setting is ignored rather than letting it look effective", () => {
    const w = validateConfig({ media: { store: "r2", options: { ...ok.options, region: "us-east-1" } } } as never);
    expect(w.join(" ")).toMatch(/ignored — R2 signs against "auto"/);
  });

  it("says out loud that a public bucket is unauthenticated and permanent", () => {
    const w = validateConfig({
      media: { store: "r2", options: { ...ok.options, publicBaseUrl: "https://media.example.com" } },
    } as never);
    expect(w.join(" ")).toMatch(/permanent and unauthenticated/);
  });

  it("flags a leftover urlBase, which belongs to the disk store", () => {
    const w = validateConfig({ media: { ...ok, urlBase: "http://127.0.0.1:3000/api/media" } } as never);
    expect(w.join(" ")).toMatch(/urlBase is ignored/);
  });
});
