/**
 * SigV4 against AWS's own implementation.
 *
 * This is hand-written auth code, so it does not ship on the strength of "it
 * looked right". Recording what *this* implementation outputs would only prove
 * it is consistent with itself, so every signature below was produced by
 * `@smithy/signature-v4` — the signer inside the AWS SDK — and pasted here.
 *
 * That package is in this repo's tree transitively (via `provider-bedrock`) but
 * is deliberately *not* a dependency of this one: it is async, which is the
 * whole reason `sigv4.ts` exists. It was used as an oracle once, at authoring
 * time, and the constants are the record of that. Reproduce with:
 *
 *     new SignatureV4({ service: "s3", region, credentials, sha256: Sha256,
 *                       uriEscapePath: false, applyChecksum: false })
 *       .presign(req, { signingDate, expiresIn: 86400 })
 *
 * The first version of this file guessed the constants from memory and both
 * were wrong — a good reminder that a vector you cannot reproduce is not a
 * vector.
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

  it("matches AWS's signer for a plain presigned GET", () => {
    expect(new URL(presignUrl(base)).searchParams.get("X-Amz-Signature")).toBe(
      "13fc8027a56468fb415ec48e7f90beb819e5c6b2308109bb5fe2400f6b704a3a",
    );
  });

  it("matches AWS's signer for a nested key in another region", () => {
    const url = presignUrl({ ...base, region: "us-west-2", path: "/media/ab/abc123.wav" });
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe(
      "6c5f323321e199b0117bcdd3dca6c654e0ea6935f6b156c18667b92dd38de3d4",
    );
  });

  it("matches AWS's signer when temporary credentials add a token", () => {
    const url = presignUrl({
      ...base,
      credentials: { ...base.credentials, sessionToken: "FQoGZXIvYXdzEExampleToken==" },
    });
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe(
      "3672cdc0de3c1aa2d9104c2ead6206625b5fb55bf01781b4a6abfd0b4410f223",
    );
  });

  it("hashes the empty body rather than signing the UNSIGNED-PAYLOAD literal", () => {
    // Both appear in AWS documentation and they sign differently. Picking the
    // wrong one yields SignatureDoesNotMatch on every link, and the first
    // version of this file picked the wrong one.
    const withLiteral = presignUrl({ ...base, payloadHash: "UNSIGNED-PAYLOAD" });
    expect(new URL(withLiteral).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(presignUrl(base)).searchParams.get("X-Amz-Signature"),
    );
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
