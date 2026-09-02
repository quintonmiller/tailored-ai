/**
 * SigV4, verified two different ways because one of them was not enough.
 *
 * **Header signing** is pinned to `@smithy/signature-v4`, the signer inside the
 * AWS SDK. Byte-for-byte identical, and separately confirmed by a live S3
 * server accepting the PUT/GET/DELETE this store makes.
 *
 * **Presigning is different, and this is the trap.** The generic SigV4 signer
 * hashes the (absent) body; S3 wants the literal `UNSIGNED-PAYLOAD`. They sign
 * differently, and S3 answers the wrong one with `SignatureDoesNotMatch` on
 * every link. That is why `@aws-sdk/s3-request-presigner` exists as a separate
 * wrapper rather than a call to `SignatureV4.presign`.
 *
 * This file previously asserted the generic signer's value, matched it exactly,
 * and was wrong — every presigned URL 403'd the first time the store ran
 * against a real bucket. A library that does not model S3's presign rule is not
 * an oracle for S3's presign rule; only a live server settles it:
 *
 *     sha256("")         -> 403 SignatureDoesNotMatch
 *     UNSIGNED-PAYLOAD   -> 200
 *
 * So the presign tests below assert the *rule* (what goes in the canonical
 * request) plus a regression vector. The vector's job is to detect change, not
 * to establish correctness — correctness was established by the 200 above, and
 * `store.test.ts` re-checks the rule structurally.
 *
 * An even earlier draft guessed its constants from memory and both were wrong.
 * A vector you cannot reproduce is not a vector.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { presignUrl, sha256Hex, signRequest, uriEncode } from "../sigv4.js";

// The canonical worked example from AWS's signing documentation.
const EXAMPLE = {
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  dateStamp: "20130524",
  region: "us-east-1",
  service: "s3",
};

describe("primitives", () => {
  it("hashes the empty payload to the value S3 expects", () => {
    // The literal every SigV4 example uses for a body-less request.
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("derives the signing key by the documented four-step chain", () => {
    // Not a published constant — the assertion is the *shape* of the chain:
    // four chained HMACs, each keyed by the previous, seeded with AWS4+secret.
    // The signatures below are what pin the values.
    const kDate = createHmac("sha256", `AWS4${EXAMPLE.secretAccessKey}`).update(EXAMPLE.dateStamp).digest();
    const kRegion = createHmac("sha256", kDate).update(EXAMPLE.region).digest();
    const kService = createHmac("sha256", kRegion).update(EXAMPLE.service).digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    expect(kSigning).toHaveLength(32);
    // Order matters: swapping region and service must change the key.
    const swapped = createHmac("sha256", createHmac("sha256", kDate).update(EXAMPLE.service).digest())
      .update(EXAMPLE.region)
      .digest();
    expect(kSigning.equals(swapped)).toBe(false);
  });
});

describe("uriEncode", () => {
  it("encodes the characters encodeURIComponent leaves alone", () => {
    // AWS encodes these; encodeURIComponent does not. A key with an
    // apostrophe otherwise signs differently than it is fetched.
    expect(uriEncode("a'b(c)d!e*f")).toBe("a%27b%28c%29d%21e%2Af");
    expect(encodeURIComponent("a'b(c)d!e*f")).not.toBe(uriEncode("a'b(c)d!e*f"));
  });

  it("leaves unreserved characters alone", () => {
    expect(uriEncode("Az09-._~")).toBe("Az09-._~");
  });

  it("encodes a slash only when asked", () => {
    expect(uriEncode("a/b")).toBe("a%2Fb");
    expect(uriEncode("a/b", false)).toBe("a/b");
  });

  it("encodes multi-byte characters per UTF-8 byte", () => {
    expect(uriEncode("é")).toBe("%C3%A9");
  });
});

describe("presignUrl", () => {
  const base = {
    method: "GET" as const,
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    region: "us-east-1",
    service: "s3",
    credentials: { accessKeyId: EXAMPLE.accessKeyId, secretAccessKey: EXAMPLE.secretAccessKey },
    expiresIn: 86400,
    now: new Date("2013-05-24T00:00:00Z"),
  };

  it("signs UNSIGNED-PAYLOAD, which is what S3 accepts", () => {
    // The rule, not a recorded number. Signing the empty-body hash instead
    // produces a URL S3 answers with SignatureDoesNotMatch — this exact bug
    // shipped once and was caught only by a live bucket.
    const asLiteral = new URL(presignUrl({ ...base, payloadHash: "UNSIGNED-PAYLOAD" })).searchParams.get(
      "X-Amz-Signature",
    );
    const asEmptyHash = new URL(presignUrl({ ...base, payloadHash: sha256Hex("") })).searchParams.get(
      "X-Amz-Signature",
    );
    expect(asEmptyHash).not.toBe(asLiteral);
    // The default must be the one S3 takes.
    expect(new URL(presignUrl(base)).searchParams.get("X-Amz-Signature")).toBe(asLiteral);
  });

  it("regression vector: a plain presigned GET", () => {
    // Detects change, not correctness. Correctness is the 200 in the header
    // note above; this catches an accidental edit to the canonical request.
    expect(new URL(presignUrl(base)).searchParams.get("X-Amz-Signature")).toBe(
      "3ed0be64024db54d5574a27da223529635c383f911f80e636f0ccc13890053d2",
    );
  });

  it("region and key are both inside the signature", () => {
    const sig = (o: Parameters<typeof presignUrl>[0]) => new URL(presignUrl(o)).searchParams.get("X-Amz-Signature");
    expect(sig(base)).not.toBe(sig({ ...base, region: "us-west-2" }));
    expect(sig(base)).not.toBe(sig({ ...base, path: "/media/ab/abc123.wav" }));
  });

  it("carries every parameter S3 requires", () => {
    const u = new URL(presignUrl(base));
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(u.searchParams.get("X-Amz-Credential")).toBe(`${EXAMPLE.accessKeyId}/20130524/us-east-1/s3/aws4_request`);
    expect(u.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("86400");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  it("clamps the expiry to AWS's seven-day ceiling instead of signing a URL S3 will refuse", () => {
    expect(new URL(presignUrl({ ...base, expiresIn: 99_999_999 })).searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(new URL(presignUrl({ ...base, expiresIn: 0 })).searchParams.get("X-Amz-Expires")).toBe("1");
  });

  it("includes a session token in the signature when one is present", () => {
    const withToken = presignUrl({ ...base, credentials: { ...base.credentials, sessionToken: "TOKEN" } });
    expect(new URL(withToken).searchParams.get("X-Amz-Security-Token")).toBe("TOKEN");
    // Signed, not merely appended: the signature has to differ.
    expect(withToken.split("X-Amz-Signature=")[1]).not.toBe(presignUrl(base).split("X-Amz-Signature=")[1]);
  });

  it("changes signature when the key changes", () => {
    const a = presignUrl(base);
    const b = presignUrl({ ...base, path: "/other.txt" });
    expect(a.split("X-Amz-Signature=")[1]).not.toBe(b.split("X-Amz-Signature=")[1]);
  });
});

describe("signRequest", () => {
  const base = {
    method: "PUT" as const,
    host: "examplebucket.s3.amazonaws.com",
    path: "/media/ab/abc.png",
    region: "us-east-1",
    service: "s3",
    credentials: { accessKeyId: EXAMPLE.accessKeyId, secretAccessKey: EXAMPLE.secretAccessKey },
    headers: { "content-type": "image/png" },
    payloadHash: sha256Hex("hello"),
    now: new Date("2013-05-24T00:00:00Z"),
  };

  it("matches AWS's signer byte for byte", () => {
    expect(signRequest({ ...base, payloadHash: sha256Hex("hello world") }).authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, " +
        "Signature=368f137768945ed9998b1fa63869ff2b5d65c831876a4784ad8b514d3d9e2a93",
    );
  });

  it("signs the payload hash, so altered bytes invalidate the request", () => {
    const a = signRequest(base).authorization;
    const b = signRequest({ ...base, payloadHash: sha256Hex("goodbye") }).authorization;
    expect(a).not.toBe(b);
  });

  it("sets the headers S3 checks", () => {
    const h = signRequest(base);
    expect(h["x-amz-content-sha256"]).toBe(base.payloadHash);
    expect(h["x-amz-date"]).toBe("20130524T000000Z");
    expect(h.host).toBe(base.host);
  });

  it("lists signed headers lowercase and sorted", () => {
    const h = signRequest({ ...base, headers: { "Content-Type": "image/png", "X-Custom": "v" } });
    const signed = /SignedHeaders=([^,]+)/.exec(h.authorization)?.[1] ?? "";
    expect(signed).toBe([...signed.split(";")].sort().join(";"));
    expect(signed).toBe(signed.toLowerCase());
  });

  it("adds the security token header for temporary credentials", () => {
    const h = signRequest({ ...base, credentials: { ...base.credentials, sessionToken: "TOKEN" } });
    expect(h["x-amz-security-token"]).toBe("TOKEN");
    expect(h.authorization).toContain("x-amz-security-token");
  });
});
