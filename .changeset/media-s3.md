---
"@tailored-ai/media-s3": patch
---

New package: an S3 media store, so media too large to attach still arrives.

Discord caps an attachment at 8 MB — roughly 2.9 minutes of WAV. Past that core
falls back to a link, and a disk store can only offer a `127.0.0.1` URL that
does not resolve from a phone. This store keeps bytes in S3 and returns a
presigned link instead.

Metadata stays in core's `media` table with the S3 key in `path`, so the
retention sweep, `touchMedia` and the byte total all see it — a store with its
own table would leak objects forever.

Zero dependencies. SigV4 is implemented here, synchronously, because
`MediaStore.urlFor` is synchronous and the AWS presigner is not; signatures are
pinned byte-for-byte against `@smithy/signature-v4` in tests. Because it is only
SigV4 over HTTP, it works unchanged against MinIO, R2 and B2 via `endpoint`,
whose scheme is honoured so a plain-http dev service works.

Credentials are an explicit key pair or the standard environment variables —
no SSO or instance roles, which would need the SDK.
