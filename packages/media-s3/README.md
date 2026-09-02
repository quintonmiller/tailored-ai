# @tailored-ai/media-s3

Keeps media in S3 instead of on the box, and hands surfaces a **presigned link**
when the bytes are too big to attach.

```yaml
plugins:
  - "@tailored-ai/media-s3"

media:
  store: s3
  bucket: my-tai-media
  region: us-west-2
  accessKeyId: ${AWS_ACCESS_KEY_ID}
  secretAccessKey: ${AWS_SECRET_ACCESS_KEY}
```

## The problem it solves

Discord caps an attachment at 8 MB — about 2.9 minutes of WAV. Past that, core's
render ladder falls back to a link, and a link only helps if it resolves from
wherever the person is reading. A local disk store can offer
`http://127.0.0.1:3000/api/media/…`, which does not resolve from a phone. A
presigned S3 URL does.

## Settings

| Key | Default | |
|---|---|---|
| `bucket` | — | required |
| `region` | `$AWS_REGION` | required one way or the other |
| `accessKeyId` / `secretAccessKey` | `$AWS_ACCESS_KEY_ID` / `$AWS_SECRET_ACCESS_KEY` | |
| `sessionToken` | `$AWS_SESSION_TOKEN` | for temporary credentials |
| `prefix` | `media` | key prefix inside the bucket |
| `urlExpiresIn` | `3600` | link lifetime, seconds (60s–7d) |
| `maxBytes` | 32 MB | refuses a larger put |
| `endpoint` | — | for an S3-compatible service |
| `forcePathStyle` | — | bucket in the path, not the hostname |

Keys are content-addressed and fanned out: `media/ab/abc…def.wav`. Identical
bytes are stored once, and a re-put costs a `HEAD` rather than an upload.

## S3-compatible services

Works unchanged against MinIO, R2 and B2 — it is SigV4 over HTTP, not an SDK.
The endpoint's scheme is honoured, so a plain-http MinIO on a private network
is fine.

```yaml
media:
  store: s3
  endpoint: http://minio:9000
  forcePathStyle: true
  bucket: tai
  region: us-east-1
```

## Credentials

An explicit key pair, or `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from the
environment. **That is all.** No SSO, no instance roles, no
`~/.aws/credentials`, because those need the AWS SDK and pretending to support
them by parsing the file badly would be worse than not supporting them. A
deployment that needs the full chain should write its own store — the registry
exists for that.

Give the credential the least it needs: `s3:PutObject`, `s3:GetObject`,
`s3:DeleteObject` on `arn:aws:s3:::<bucket>/<prefix>/*`. `HEAD` is covered by
`GetObject`. No `ListBucket` is required.

## Why the bucket should be private

Links are presigned and expire (an hour by default), so the bucket does not need
public read — and should not have it. A presigned link is a bearer credential
for one object: short expiry limits what a leaked one is worth. It is computed
fresh on every render rather than stored, so shortening the expiry costs nothing
and old links in old messages simply stop working, which is the intent.

## No SDK

`@aws-sdk/client-s3` is tens of megabytes landing in every
`<TAI_HOME>/plugins/` for PUT/GET/HEAD/DELETE of one object. Shelling out to the
`aws` CLI, which is what `deploy-aws` does, is wrong here for a different
reason: this sits on the media path and a process spawn per blob is a cost the
disk store does not pay.

So SigV4 is implemented here (`sigv4.ts`), synchronously — `MediaStore.urlFor`
is sync and the AWS presigner is async. Every signature is pinned in tests
against `@smithy/signature-v4`, the signer inside the AWS SDK, byte for byte.
