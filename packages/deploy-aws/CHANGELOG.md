# @tailored-ai/deploy-aws

## 0.1.11

### Patch Changes

- Updated dependencies [9018bc8]
- Updated dependencies [9dc9836]
- Updated dependencies [e21c40e]
- Updated dependencies [0651034]
- Updated dependencies [5c6f252]
- Updated dependencies [0b62d07]
- Updated dependencies [38b808b]
- Updated dependencies [662b23a]
- Updated dependencies [f13cec6]
- Updated dependencies [0c8e8c4]
- Updated dependencies [390be8e]
- Updated dependencies [bf2faf1]
- Updated dependencies [b17aa82]
- Updated dependencies [bf2faf1]
- Updated dependencies [2c98cab]
- Updated dependencies [b8e39ef]
- Updated dependencies [49e6ce4]
- Updated dependencies [02f9be2]
- Updated dependencies [662b23a]
- Updated dependencies [38b808b]
- Updated dependencies [2c98cab]
- Updated dependencies [afdfc82]
- Updated dependencies [0594a2b]
- Updated dependencies [325e5f2]
- Updated dependencies [38b808b]
- Updated dependencies [bf2faf1]
- Updated dependencies [3d27ba5]
- Updated dependencies [1d83122]
- Updated dependencies [415ba15]
- Updated dependencies [0594a2b]
- Updated dependencies [a098702]
- Updated dependencies [d4c4baa]
- Updated dependencies [1537522]
- Updated dependencies [0b90020]
- Updated dependencies [6557b85]
- Updated dependencies [bdacf8d]
- Updated dependencies [2e7a342]
- Updated dependencies [9190838]
- Updated dependencies [2c98cab]
- Updated dependencies [1d83122]
- Updated dependencies [1537522]
- Updated dependencies [e21c40e]
  - @tailored-ai/core@0.1.11

## 0.1.10

### Patch Changes

- 1c7cae1: New package: AWS deploy target. `tai deploy up aws-ec2` runs TAI on a single
  EC2 instance with an encrypted EBS root volume.

  One instance, deliberately — TAI's state is SQLite and takes a single writer,
  which also rules out Fargate/App Runner (SQLite on EFS breaks WAL locking, and
  scale-to-zero stops cron and autopilot).

  Talks to AWS through the `aws` CLI rather than the SDK, matching how the repo
  already shells out to `gh` and `docker`, and so credentials work however they
  already work for the user — env, `~/.aws`, `AWS_PROFILE`, SSO — with no second
  credential path to get wrong.

  `plan` sends the real launch request with `--dry-run`, so AWS validates the
  AMI, instance type, volume, tags, user-data and IAM permissions server-side
  before anything is created; `up` refuses when that comes back with a problem.

  Secure by default: port 3000 is closed (the bundled dashboard cannot send an
  API token, so the supported path in is an SSH tunnel), `--allow-http-from
0.0.0.0/0` additionally requires `--force-public`, the root volume is
  encrypted, IMDSv2 is required, and the provider API key is written to a
  root-owned 0600 file rather than passed through instance user-data.

  Deployment identity lives in EC2 tags, so `status` and `down` work from any
  machine with credentials and there is no local state file to desync.

- c120f51: Make `server.proxyAuth` actually authenticate, so the dashboard works remotely.

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

- Updated dependencies [b559646]
- Updated dependencies [ef9e809]
- Updated dependencies [a2f8016]
- Updated dependencies [ed98f4a]
- Updated dependencies [b559646]
- Updated dependencies [920a799]
- Updated dependencies [fecc3d8]
- Updated dependencies [2632f51]
- Updated dependencies [9af06b7]
- Updated dependencies [b8f5d16]
- Updated dependencies [aee6802]
- Updated dependencies [9d32c15]
- Updated dependencies [8b0c45a]
- Updated dependencies [f67b15a]
- Updated dependencies [7447619]
- Updated dependencies [fd84749]
- Updated dependencies [b559646]
- Updated dependencies [d9e294f]
- Updated dependencies [b1ec29a]
- Updated dependencies [fd19549]
- Updated dependencies [a38b5fc]
- Updated dependencies [1206560]
- Updated dependencies [0a3b591]
- Updated dependencies [dc312f1]
- Updated dependencies [5a01ceb]
- Updated dependencies [b1cdad9]
- Updated dependencies [0fb08f4]
- Updated dependencies [0fb08f4]
- Updated dependencies [0fb08f4]
- Updated dependencies [54ce46f]
- Updated dependencies [7017c2d]
- Updated dependencies [7d273b5]
- Updated dependencies [b559646]
- Updated dependencies [e6cb5fb]
- Updated dependencies [e66f07b]
- Updated dependencies [0187e0c]
- Updated dependencies [b559646]
- Updated dependencies [daa6302]
- Updated dependencies [a970a8b]
- Updated dependencies [57a5d48]
- Updated dependencies [39445bb]
- Updated dependencies [4c48ad8]
- Updated dependencies [ba7bad5]
- Updated dependencies [571adba]
- Updated dependencies [de1ce69]
- Updated dependencies [87fc6fd]
- Updated dependencies [611f94d]
- Updated dependencies [8aa5720]
- Updated dependencies [d2b5939]
- Updated dependencies [7e9a130]
- Updated dependencies [b559646]
- Updated dependencies [d3a4cf1]
- Updated dependencies [36a50b7]
- Updated dependencies [4656518]
- Updated dependencies [d3e79e3]
- Updated dependencies [128c561]
- Updated dependencies [30a0c14]
- Updated dependencies [df2d055]
- Updated dependencies [9ccec1f]
- Updated dependencies [e698f39]
- Updated dependencies [b8fe10c]
- Updated dependencies [0d4f4b6]
- Updated dependencies [6460c00]
- Updated dependencies [0039c3a]
- Updated dependencies [8d0f50e]
- Updated dependencies [9b13c86]
- Updated dependencies [c120f51]
- Updated dependencies [7c6217a]
- Updated dependencies [449e827]
- Updated dependencies [58dd367]
- Updated dependencies [bbcde3b]
- Updated dependencies [2c0fde1]
- Updated dependencies [0b7a0f7]
- Updated dependencies [19188db]
- Updated dependencies [20f9fe1]
- Updated dependencies [7f620a0]
- Updated dependencies [b559646]
- Updated dependencies [9883913]
- Updated dependencies [77781ef]
- Updated dependencies [b7788ad]
- Updated dependencies [7e05a94]
- Updated dependencies [e3b1bc5]
- Updated dependencies [920a799]
- Updated dependencies [920a799]
- Updated dependencies [b559646]
- Updated dependencies [682e304]
- Updated dependencies [d492806]
- Updated dependencies [dd3951c]
- Updated dependencies [544aac2]
- Updated dependencies [87d2af3]
- Updated dependencies [c308241]
- Updated dependencies [cc792f2]
- Updated dependencies [7d273b5]
- Updated dependencies [42a1e90]
- Updated dependencies [2963457]
- Updated dependencies [9ec3100]
- Updated dependencies [248931d]
- Updated dependencies [4b54275]
- Updated dependencies [22f9b9e]
- Updated dependencies [d7656d8]
- Updated dependencies [afc05a2]
- Updated dependencies [dd3951c]
- Updated dependencies [1ad506a]
- Updated dependencies [a1231c6]
- Updated dependencies [1d9e6a6]
- Updated dependencies [f0bb132]
- Updated dependencies [19996ac]
- Updated dependencies [28bb474]
- Updated dependencies [244cdcf]
- Updated dependencies [a00b73a]
- Updated dependencies [b559646]
- Updated dependencies [c50e55a]
- Updated dependencies [bcc2159]
- Updated dependencies [42d98c6]
- Updated dependencies [b8a8da4]
- Updated dependencies [cf2cd34]
  - @tailored-ai/core@0.1.10
