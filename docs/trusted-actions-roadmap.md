# Trusted-actions roadmap

Open work after the v1 end-to-end ship (real Amazon purchase verified via the `--place-order` manual path). Each item is tracked as a task under project `Tailored AI (TAI)`; the design notes here are the canonical reference for each task. Update both when scope changes.

Cross-references:
- Architecture + threat model: [`trusted-actions.md`](./trusted-actions.md)
- Ops runbook (setup, PWA, tunnel): [`trusted-actions-runbook.md`](./trusted-actions-runbook.md)
- Threat model: [`trusted-actions-threats.md`](./trusted-actions-threats.md)

## R1 — Clear cart at the start of every purchase ✓ Shipped

**Why now**: in this session, a stale item in the Amazon cart silently joined the order we placed via `--place-order`. The dry-run guards against this (`GUARD 1: cart empty`) but the production adapter didn't.

**Shipped**:
- `clearCart(page)` moved from `test-purchase.ts` to `amazon-flow.ts`. Returns `{ initial, remaining }` so callers can audit + verify.
- `purchase-amazon.ts execute()` calls it after session load, before navigating to the product. Writes `cart.cleared { count, remaining }` audit when `initial > 0`. Throws + screenshots if the cart can't be fully emptied (prevents a partial-clear adding to a non-empty cart).
- `test-purchase.ts --clear-cart` now uses the shared helper too.

**Out of scope**: prompting the user — the cart is the executor's working surface, not a user surface. If you want stuff in your real cart, use a different Amazon account or set the executor's session to a dedicated `+purchases@` alias.

---

## R2 — Encrypted password vault + auto-fill on re-auth

**Why now**: Amazon enforces `pape.max_auth_age=900` for checkout, so even with a saved session we hit a sign-in wall ~15 min into the next purchase. Manual password entry breaks the autonomous-agent loop (operator is unavailable; the action is sitting in `running` with Playwright stuck on the password page).

**Threat model**: the executor already holds:
- Amazon session cookies (`secrets/amazon_session.json`, AES-256-GCM with operator passphrase)
- VAPID keypair (`secrets/vapid.json`, same encryption)
- Shared secret + approval HMAC key (in `.env`, mode 600)

Adding a password is **one more secret with the same blast radius**, not a new attack surface — anyone who already has the operator passphrase plus filesystem read can drain the Amazon account either way. Don't add the password if you're not comfortable with the existing model.

**Design**:
- New age-store key `amazon_password.json` containing `{ "password": "..." }`.
- CLI subcommand `tai-executor setup amazon-password`. Reads from stdin (no echo) → encrypts → writes → wipes the stdin buffer. NEVER as a CLI argument or env var.
- In the production adapter's flow, after each navigation step, check whether the URL is `/ap/signin*`. If so:
  1. Audit `auth.reauth.required { url }`.
  2. Decrypt password.
  3. Fill `#ap_password`. Click `#signInSubmit`. Wait for nav.
  4. Audit `auth.reauth.completed`.
  5. Zero the password buffer in JS via `password = "\0".repeat(password.length)` (defense against memory scraping; Playwright's process memory is suspect anyway).
  6. Resume the original flow.
- If the re-auth itself fails (wrong password, captcha, 2FA), the adapter throws `ReauthError` and the action goes to `failed` with the captcha screenshot.

**What we do NOT solve**:
- 2FA. If your Amazon account has TOTP enabled (you should), the adapter can't proceed. Out-of-band design needed: prompt the operator via push, accept a TOTP code through a new PWA screen, fill it. Tracked separately if/when needed.
- Captcha. Same — no auto-solve. Surface the screenshot and fail.

**Rotation**: `tai-executor setup amazon-password --force`. Same passphrase, same blob path; just overwrites.

---

## R3 — Agent reads + actions with HITL, no exfiltration ✓ Shipped

**Shipped**:
- Three executor-side adapters in `packages/trusted-actions/src/read-actions/`: `ProductSummaryAdapter`, `OrderHistoryAdapter`, `CartStateAdapter`. Each declares `autoApprove: true` and a typed output schema. Registered at `serve` startup in `cli/bin.ts`.
- `POST /internal/read` route on the executor (shared-secret auth). Validates input via the adapter's `validate()`, executes, persists the action row, audits the read, returns `{ action_id, result }`.
- TAI-side `RequestReadTool` in `packages/core/src/tools/request-action.ts`. Calls `/internal/read` synchronously and returns the typed result to the agent. Wired into `factories.createMetaTools` alongside `RequestActionTool` / `PurchaseItemTool` / `CheckActionStatusTool`.
- Read-actions test suite (`__tests__/read-actions.test.ts`, 22 tests): validation, registry, audit chain integrity.

**Invariant kept**: schemas are static and reviewed at compile time. Adding a new field requires a code change. The agent literally cannot request fields a schema doesn't model. Sensitive fields (shipping address, last-4 card) are not in any current schema — opt-in via a future `amazon_read.shipping_address` with explicit `trustedActions.allowAddressRead` config gate.

**Original design (preserved for reference):**

**Problem**: today the agent (LLM) is fully decoupled from the executor — the executor never echoes credentials, payment data, or recovered approval URLs back to the agent. This is good for exfiltration safety but bad for UX:
- Agent can't see "I ordered X" responses except via summarized callback strings
- Agent can't reason about cart state, order history, prices over time
- Anything the agent wants to know it has to re-derive via tools (slow, lossy)

**Threat we keep**: prompt injection routes credentials to attacker. Today: impossible — the LLM never sees credentials. Naive expansion of agent visibility breaks this.

**Design — capability-narrowed read tools**:
- New tool family `amazon_read.*` registered as trusted-actions tools. Each tool is a hand-coded, narrow read with a typed output schema. Examples:
  - `amazon_read.order_history(since: ISO8601, limit: int)` → `[{order_id, date, items: [{title, asin, price_usd}], total_usd, status}]`
  - `amazon_read.cart_state()` → `[{title, asin, qty, price_usd}]`
  - `amazon_read.product_summary(url|asin)` → `{title, price_usd, rating, review_count, availability}`
- Each tool runs in the executor (Playwright + saved session), parses the page, and returns ONLY the schema-typed fields. No raw HTML, no cookies, no URL with tokens, no PII the schema doesn't list.
- The executor enforces the schema at the type level — if a field isn't in the schema, it doesn't leave the executor. The agent literally cannot ask for a field that wasn't pre-modeled.
- Sensitive fields (e.g. shipping address, last-4 of card) are explicitly excluded unless added to a separate `amazon_read.shipping_address()` tool that requires explicit operator pre-authorization (a config-level boolean like `trustedActions.allowAddressRead: true`).

**Threat surface comparison**:
- Today: 0 read tools, 1 narrow write path (purchase). Prompt injection → max damage is queuing a purchase up to the cap.
- Proposed: N hand-coded read tools with strict schemas, 1 write path. Prompt injection → max damage is queuing a purchase up to the cap PLUS leaking any field the schema models. If `shipping_address` isn't in any schema, an injected prompt can't extract it.
- Key invariant: **schemas are static and reviewed**. Adding a new tool / field is a deliberate operator decision, not something the LLM can request at runtime.

**HITL stays unchanged**: write actions still require approval via push + decide screen. Reads don't require approval (they're idempotent + bounded by the schema), but every read is audited so the operator can see what the agent looked at.

**Why hand-coded narrow tools, not "generic browser_read"**:
- A generic tool that returns raw HTML or full page text is a credential-exfiltration vehicle (saved cookies in `document.cookie`, addresses, last-4 cards, etc.).
- A `query the DOM by XPath` tool is the same risk in a fancier coat.
- Hand-coded tools force someone to think about each field's sensitivity before it crosses the executor → agent boundary.

**Out of scope (for now)**:
- Generalizing beyond Amazon. Each retailer would need its own `*_read.*` family.
- Multi-step queries that join across tools (e.g. "did I order X recently and is it cheaper now"). Agent composes via existing tools; we don't add `read_and_compare`.

**First wave of tools**:
1. `amazon_read.product_summary(url|asin)` — needed for the agent to verify what it's about to buy.
2. `amazon_read.order_history(since, limit)` — needed for R5 too (PWA).
3. `amazon_read.cart_state()` — needed to catch state leaks from R1.

---

## R4 — PWA decide screen links to the product page ✓ Shipped

**Why now**: when the push hits your phone, all you see is "Purchase: <title>" + price + cap. You can't easily verify the listing is what you expect (right model, right color, right seller) without opening Amazon and pasting an ASIN.

**Shipped**:
- `ActionCard.productUrl` carried through `sendApprovalPush` into `payload.data.productUrl`.
- SW `notificationclick` includes `productUrl` in the cache-handoff `decide` blob, postMessage payload, and URL-hash fallback (`u=`).
- PWA `showDecideView` calls `renderDecideTitle(title, productUrl)` which renders an `<a target="_blank" rel="noopener noreferrer">` when the URL is http(s), plain text otherwise.
- `/pending` server fallback returns a best-effort `productUrl` derived from `input.url` or an ASIN extracted from `input.query`.

**Out of scope** (future work if useful):
- Image thumbnail. `ApprovalCard.imageUrl` exists but isn't threaded to the decide view yet.

---

## R5 — PWA shows past purchases ✓ Shipped

**Why now**: the audit log lives in SQLite on the executor host. There's no portable view of "what has TAI bought for me?" Useful for: spot-check after a purchase, monthly reconcile against credit card, sanity-check the agent isn't doing weird things.

**Shipped**:
- `GET /internal/actions/history` on the executor (shared-secret auth, cursor-paged via `?before=<requested_at>`, `?limit=`). For TAI dashboard use.
- `POST /history` on the executor (PWA-facing; endpoint-as-credential — same pattern as `/pending`, gated to `status='active'` subscriptions). Body: `{endpoint, before?, limit?}`.
- TAI proxy `GET /api/trusted-actions/history?before=&limit=` → `/internal/actions/history`.
- PWA "Past purchases" card: list of entries with status badge (completed/failed/rejected), title-as-link (when product_url derivable), price, decided_at, and a link to Amazon's order details page when `order_id` is present. "Load more" button uses the cursor.

**Privacy** (kept from original design):
- Endpoint is gated by `status='active'` push subscription — unsubscribed / pending devices see an empty list with a "Enable notifications to view past purchases" message.
- Order IDs are not secrets, but the existence of a purchase is — hence the subscription gate.

**Out of scope** (now and going forward unless needed):
- Showing pending / running actions on the same page (those live on the Approvals page in TAI).
- Filtering / search. Trivial to add later if 50 entries gets unwieldy.
- Background refresh of the list while idle — currently re-loads on visibility-change only.

---

## Ordering recommendation

R1 (cart-clear) is a one-hour fix that prevents the next surprise — do first.
R4 (link to product page) is similarly small, same urgency as R1.
R2 (password vault) gates the next real-world purchase if the operator isn't around to type the password.
R3 (read tools) and R5 (history view) are the meatier ones; do after the autonomy loop is solid.
