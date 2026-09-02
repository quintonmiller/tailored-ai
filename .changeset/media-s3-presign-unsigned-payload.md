---
"@tailored-ai/media-s3": patch
---

Presigned URLs sign `UNSIGNED-PAYLOAD`, which is what S3 accepts.

They briefly signed the hash of the empty body instead, because that is what
the generic SigV4 signer in the AWS SDK (`@smithy/signature-v4`) emits and the
tests were pinned to it. S3 answers that with `SignatureDoesNotMatch` on every
link — which is why `@aws-sdk/s3-request-presigner` exists as a separate wrapper
rather than a call to `SignatureV4.presign`.

A library that does not model S3's presign rule is not an oracle for S3's
presign rule. The tests now assert the rule and keep a regression vector,
and the rule was settled against a live bucket: the empty-body hash 403s, the
literal returns 200.
