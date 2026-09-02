/**
 * AWS Signature Version 4, synchronously.
 *
 * Written rather than imported, for one reason: `MediaStore.urlFor` is
 * synchronous and is called at render time, and `@aws-sdk/s3-request-presigner`
 * is async. Caching a presigned URL at upload time instead would work until it
 * expired — seven days at most — and then links in old messages would quietly
 * stop resolving. Signing per render is both simpler and never stale.
 *
 * That works because SigV4 is a chain of HMAC-SHA256s over strings. There is no
 * I/O in it. `node:crypto` is synchronous, so this is too.
 *
 * The scope is deliberately small: what S3 needs, over https, for GET/PUT/
 * DELETE/HEAD of a single object. No chunked uploads, no STS, no request
 * retries. A mistake here produces a signature S3 rejects, not a security
 * hole — this signs, it never verifies — but it is still auth code, so every
 * step below is pinned against AWS's own published test vectors in
 * `sigv4.test.ts`.
 *
 * Reference: "Signature Version 4 signing process", AWS General Reference.
 */
import { createHash, createHmac } from "node:crypto";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present for temporary credentials (STS, SSO, instance roles). */
  sessionToken?: string;
}

export interface SignParams {
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  /** Host header, e.g. `bucket.s3.us-west-2.amazonaws.com`. */
  host: string;
  /** Absolute path, already percent-encoded. */
  path: string;
  region: string;
  service: string;
  credentials: Credentials;
  /** Overridable so tests can pin a moment; defaults to now. */
  now?: Date;
}

export interface SignedRequest extends SignParams {
  headers: Record<string, string>;
  /** Hex sha256 of the body, or UNSIGNED-PAYLOAD. */
  payloadHash: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `20260902T143000Z` and `20260902`. */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` alone and AWS does
 * not, and a key containing any of them signs to a different string than it
 * is fetched with — a mismatch that shows up as `SignatureDoesNotMatch` on
 * exactly the files whose names have an apostrophe in them.
 */
export function uriEncode(str: string, encodeSlash = true): string {
  let out = "";
  for (const ch of str) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/") out += encodeSlash ? "%2F" : "/";
    else {
      for (const byte of Buffer.from(ch, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function canonicalQuery(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function signingKey(credentials: Credentials, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function stringToSign(amzDate: string, scope: string, canonicalRequest: string): string {
  return [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
}

/**
 * Sign a request with an `Authorization` header. Used for PUT/GET/DELETE the
 * store makes itself.
 */
export function signRequest(req: SignedRequest): Record<string, string> {
  const now = req.now ?? new Date();
  const { amzDate, dateStamp } = stamps(now);
  const scope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;

  const headers: Record<string, string> = {
    ...req.headers,
    host: req.host,
    "x-amz-content-sha256": req.payloadHash,
    "x-amz-date": amzDate,
    ...(req.credentials.sessionToken ? { "x-amz-security-token": req.credentials.sessionToken } : {}),
  };

  // Header names lowercase, sorted, values trimmed — the canonical form.
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n] ?? findHeader(headers, n)).trim()}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [req.method, req.path, "", canonicalHeaders, signedHeaders, req.payloadHash].join("\n");

  const signature = hmac(
    signingKey(req.credentials, dateStamp, req.region, req.service),
    stringToSign(amzDate, scope, canonicalRequest),
  ).toString("hex");

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${req.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function findHeader(headers: Record<string, string>, lower: string): string {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  return key ? headers[key] : "";
}

/** sha256 of the empty string — the body a presigned GET does not have. */
export const EMPTY_SHA256 = sha256Hex("");

export interface PresignParams extends SignParams {
  /** Override the hashed payload. Defaults to `UNSIGNED-PAYLOAD`, which is
   *  what S3 requires for a presigned URL. */
  payloadHash?: string;
  /** Seconds the link stays valid. AWS caps this at 7 days. */
  expiresIn: number;
  /** Extra query parameters to sign, e.g. a response content-disposition. */
  query?: Array<[string, string]>;
  /** `https` unless an S3-compatible endpoint says otherwise. */
  scheme?: string;
}

/**
 * A URL that fetches the object without credentials, until it expires.
 *
 * Synchronous, which is the whole reason this file exists.
 */
export function presignUrl(p: PresignParams): string {
  const now = p.now ?? new Date();
  const { amzDate, dateStamp } = stamps(now);
  const scope = `${dateStamp}/${p.region}/${p.service}/aws4_request`;
  const signedHeaders = "host";

  const query: Array<[string, string]> = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${p.credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(Math.min(Math.max(Math.floor(p.expiresIn), 1), 604800))],
    ["X-Amz-SignedHeaders", signedHeaders],
    ...(p.credentials.sessionToken
      ? ([["X-Amz-Security-Token", p.credentials.sessionToken]] as Array<[string, string]>)
      : []),
    ...(p.query ?? []),
  ];

  const canonicalQueryString = canonicalQuery(query);
  const canonicalRequest = [
    p.method,
    p.path,
    canonicalQueryString,
    `host:${p.host}\n`,
    signedHeaders,
    // `UNSIGNED-PAYLOAD`, not the hash of the empty body.
    //
    // Both appear in AWS documentation and they sign differently. The generic
    // SigV4 signer in the AWS SDK (`@smithy/signature-v4`) emits the empty-body
    // hash; S3 rejects that for a presigned GET with SignatureDoesNotMatch,
    // which is why `@aws-sdk/s3-request-presigner` exists as a separate wrapper
    // that sets `unsignedPayload`. Verified the only way that settles it: both
    // variants against a live S3 server. See sigv4.test.ts.
    p.payloadHash ?? "UNSIGNED-PAYLOAD",
  ].join("\n");

  const signature = hmac(
    signingKey(p.credentials, dateStamp, p.region, p.service),
    stringToSign(amzDate, scope, canonicalRequest),
  ).toString("hex");

  return `${p.scheme ?? "https"}://${p.host}${p.path}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}
