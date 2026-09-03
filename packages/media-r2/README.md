# @tailored-ai/media-r2

Cloudflare R2 as a media store.

```yaml
plugins:
  - "@tailored-ai/media-r2"

media:
  store: r2
  options:
    accountId: ${R2_ACCOUNT_ID}
    bucket: tai-media
    accessKeyId: ${R2_ACCESS_KEY_ID}
    secretAccessKey: ${R2_SECRET_ACCESS_KEY}
```

## Why this exists when `media-s3` already talks to R2

It does — R2 is S3's API, and `@tailored-ai/media-s3` reaches it given the right
`endpoint`. Three settings have to be exactly right, none are discoverable, and
a wrong one fails with `SignatureDoesNotMatch`, which names none of them:

| | |
|---|---|
| endpoint | `https://<account-id>.r2.cloudflarestorage.com` |
| signing region | `auto` — anything else is refused |
| addressing | path-style, under the account endpoint |

Here they are filled in. `accountId` is the only new thing to learn. This is the
same reason `provider-deepseek` sits beside `provider-openai`.

## Why R2 over S3 for this workload

Egress. R2 charges none, and the free tier is 10 GB-month of storage plus 1M
writes and 10M reads. A media store whose job is handing out links is the case
that pricing was written for — a personal deployment generating a couple of
podcasts a day sits inside the free tier indefinitely.

## Settings

| Key | Default | |
|---|---|---|
| `accountId` | — | required, unless `endpoint` is given |
| `bucket` | — | required |
| `accessKeyId` / `secretAccessKey` | `$R2_ACCESS_KEY_ID` / `$R2_SECRET_ACCESS_KEY` | R2 → Manage API Tokens |
| `prefix` | `media` | key prefix in the bucket |
| `urlExpiresIn` | `3600` | presigned link lifetime, 60s–7d |
| `maxBytes` | 32 MB | refuses a larger put |
| `publicBaseUrl` | — | see below |
| `endpoint` | derived | override for a non-standard endpoint |

`region` is accepted and ignored, with a warning — R2 signs against `auto`.

## Public links

R2 buckets can be exposed on an `r2.dev` subdomain or a custom domain. Point
`publicBaseUrl` at one and `urlFor` returns a plain, permanent URL instead of a
presigned one:

```yaml
    publicBaseUrl: https://media.example.com
```

Useful when a link should outlive the presign window — a podcast you want to
share later, an image in a page.

**It is also a privacy decision**, so `validateConfig` says so every startup:
anyone holding the URL can fetch that object, forever, without credentials.
Object keys are sha256 content hashes and therefore unguessable, but "hard to
guess" is not "access controlled". The default is presigned and private.

## Credentials

An explicit key pair, or `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. Create one
in the Cloudflare dashboard under **R2 → Manage API Tokens**; the store needs
object read and write on the bucket, and no bucket-level permissions.

## What it does not do

R2's S3 API omits ACLs, tagging, versioning and bucket policies. None are used
here. Lifecycle rules are configured in Cloudflare rather than through this
plugin — worth setting one, since core does not yet sweep expired media
([#638](https://github.com/quintonmiller/tailored-ai/issues/638)).
