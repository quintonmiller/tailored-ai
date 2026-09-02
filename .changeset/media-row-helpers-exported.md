---
"@tailored-ai/core": patch
---

Export the `media` row helpers, so an out-of-tree media store can keep its
metadata where core looks for it.

`registerMediaStoreFactory` has always said a deployment can bring its own
store, and the interface doc names S3. But core exported only the *reading*
half of the table — `findExpiredMedia`, `listMediaRows`, `totalMediaBytes` —
so a plugin could observe the table and not participate in it.

That matters because the `media` table is not bookkeeping, it is the contract.
The retention sweep walks it and calls `MediaStore.delete`; `touchMedia` keeps a
blob alive when a rendition of it is served; the byte total sums it. A store
that invents its own table is invisible to all three: its blobs never expire and
never appear in a total, and its schema drifts from core's at the next
migration.

`upsertMediaRow`, `getMediaRow`, `deleteMediaRow` and `touchMedia` are now
public. No behaviour change; the bundled disk store already used them.
