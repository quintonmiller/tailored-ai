/**
 * The four S3 operations a media store needs, over `fetch`.
 *
 * No SDK. `@aws-sdk/client-s3` is tens of megabytes that would land in every
 * `<TAI_HOME>/plugins/` that installs this, for PUT/GET/HEAD/DELETE of a single
 * object — the same argument `deploy-aws` makes for shelling out to the CLI.
 * Shelling out is wrong here for a different reason: this sits on the media
 * path, and a process spawn per blob is a cost the disk store does not pay.
 *
 * The trade is real and worth stating: no SSO, no IMDS, no instance roles, no
 * retry/backoff policy. Credentials are an explicit key pair or the standard
 * environment variables. A deployment that needs the full credential chain
 * should use the SDK and write its own store — the registry exists for exactly
 * that.
 *
 * Because it is only SigV4 over HTTPS, it works unchanged against MinIO, R2,
 * Backblaze B2 and anything else that speaks S3, given `endpoint`.
 */
import { type Credentials, presignUrl, sha256Hex, signRequest, uriEncode } from "./sigv4.js";

export interface S3ClientOptions {
  bucket: string;
  region: string;
  credentials: Credentials;
  /**
   * Override for an S3-compatible service, e.g. `https://<id>.r2.cloudflarestorage.com`.
   * Unset means AWS S3.
   */
  endpoint?: string;
  /**
   * Put the bucket in the path instead of the hostname. Required by most
   * self-hosted S3 services, which have no wildcard DNS.
   */
  forcePathStyle?: boolean;
  timeoutMs?: number;
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

export class S3Client {
  constructor(private readonly opts: S3ClientOptions) {}

  /**
   * Host, path and scheme for a key, honouring endpoint and path-style.
   *
   * The scheme comes from `endpoint` rather than being assumed https, because
   * a self-hosted MinIO in a dev compose file is routinely plain http on a
   * private network. Hardcoding https there fails with a TLS error that names
   * nothing useful. AWS itself is always https.
   */
  private target(key: string): { host: string; path: string; scheme: string } {
    const encoded = `/${uriEncode(key, false)}`;
    if (this.opts.endpoint) {
      const url = new URL(this.opts.endpoint);
      const scheme = url.protocol.replace(":", "");
      return this.opts.forcePathStyle === false
        ? { host: `${this.opts.bucket}.${url.host}`, path: encoded, scheme }
        : { host: url.host, path: `/${this.opts.bucket}${encoded}`, scheme };
    }
    return this.opts.forcePathStyle
      ? { host: `s3.${this.opts.region}.amazonaws.com`, path: `/${this.opts.bucket}${encoded}`, scheme: "https" }
      : { host: `${this.opts.bucket}.s3.${this.opts.region}.amazonaws.com`, path: encoded, scheme: "https" };
  }

  private async send(
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    key: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const { host, path, scheme } = this.target(key);
    const headers = signRequest({
      method,
      host,
      path,
      region: this.opts.region,
      service: "s3",
      credentials: this.opts.credentials,
      headers: extraHeaders,
      payloadHash: sha256Hex(body ?? ""),
    });

    let res: Response;
    try {
      res = await fetch(`${scheme}://${host}${path}`, {
        method,
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      const e = err as Error;
      const why = e.name === "TimeoutError" ? "timed out" : e.message;
      throw new S3Error(0, undefined, `${method} s3://${this.opts.bucket}/${key} failed: ${why}`);
    }

    if (!res.ok && res.status !== 404) {
      // S3 explains itself in an XML body; a bare status code does not say
      // whether the bucket is wrong, the region is wrong, or the clock is.
      const text = await res.text().catch(() => "");
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1];
      throw new S3Error(
        res.status,
        code,
        `${method} s3://${this.opts.bucket}/${key} -> ${res.status}` +
          (code ? ` ${code}` : "") +
          (message ? `: ${message}` : ""),
      );
    }
    return res;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.send("PUT", key, bytes, { "content-type": contentType });
  }

  /** Bytes, or undefined when the key is absent. */
  async get(key: string): Promise<Buffer | undefined> {
    const res = await this.send("GET", key);
    if (res.status === 404) return undefined;
    return Buffer.from(await res.arrayBuffer());
  }

  async exists(key: string): Promise<boolean> {
    return (await this.send("HEAD", key)).status !== 404;
  }

  /** S3 treats deleting an absent key as success, and so does this. */
  async delete(key: string): Promise<void> {
    await this.send("DELETE", key);
  }

  /**
   * A link that fetches the object without credentials until it expires.
   *
   * Synchronous, because `MediaStore.urlFor` is.
   */
  presign(key: string, expiresIn: number): string {
    const { host, path, scheme } = this.target(key);
    return presignUrl({
      scheme,
      method: "GET",
      host,
      path,
      region: this.opts.region,
      service: "s3",
      credentials: this.opts.credentials,
      expiresIn,
    });
  }
}
