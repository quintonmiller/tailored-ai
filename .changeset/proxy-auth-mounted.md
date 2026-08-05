---
"@tailored-ai/server": patch
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
"@tailored-ai/deploy-aws": patch
---

Make `server.proxyAuth` actually authenticate, so the dashboard works remotely.

The middleware and the login page both already existed. Nothing mounted the
middleware, and `/api/auth/login` was never implemented, so enabling proxyAuth
authenticated nothing while suppressing the warning that the API was open.

The server now gates `/api/*` on proxyAuth when enabled, accepting either the
password as a bearer or an HMAC-signed session cookie, and serves
`/api/auth/login` and `/api/auth/logout`. The cookie is what matters: a bearer
token cannot ride on an `EventSource` connection, so SSE (chat, the event feed)
was unreachable to a token-authenticated dashboard. That is why the bundled UI
could not be used with `authToken` alone.

Auth is one gate rather than two stacked middlewares, so "which credential
decides" is answerable by reading one function. `authToken` keeps working
alongside proxyAuth, letting scripts hold a separate secret from browsers.

Hardening:

- Session cookies are HttpOnly, SameSite=Lax, and only `Secure` when the
  request actually arrived over TLS (`x-forwarded-proto`, else the request
  URL). Setting `Secure` unconditionally makes login silently fail on a
  plain-HTTP LAN, since the browser accepts the 200 and drops the cookie.
- Failed logins are throttled per client IP, 10 per 15 minutes, keyed on
  `x-forwarded-for` so one attacker cannot lock out everyone behind a proxy.
  A correct password clears the record.
- The session HMAC is keyed by the password, so rotating it invalidates every
  issued session.
- `proxyAuth.enabled` with an empty password fails every request closed with a
  500 instead of falling open, and `validateConfig` warns about it.

Also fixes the UI's 401 interceptor swallowing `/api/auth/login`'s own 401,
which made every wrong password report "Network error" instead of the reason,
and parses the server's JSON error rather than printing it raw.
