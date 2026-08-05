---
"@tailored-ai/cli": patch
"@tailored-ai/core": patch
---

Make TAI self-hostable: headless setup plus a Docker image.

`tai init --non-interactive` writes config.yaml from flags and environment
variables, so setup no longer requires a terminal. The Ink wizard was the only
path to a config and it throws `TTYError` without a TTY, which made every
unattended first run — container, cloud-init, CI — impossible. Running `tai`
with no config and no TTY now prints that command instead of a React stack
trace.

Adds `docker/tai/` (Dockerfile, compose unit, `.env.example`): one container,
one volume at `TAI_HOME`, first boot generates config and an API token, later
boots leave the file alone. A root `.dockerignore` keeps `config.yaml`, `.env`,
and `agent.db` out of every image build context. See `docs/self-hosting.md`.

Two correctness fixes found on the way:

- `server.proxyAuth` no longer counts as authentication in `validateConfig`.
  Its middleware is never mounted and the `/api/auth/login` endpoint its login
  page posts to does not exist, so enabling it authenticated nothing while
  silencing the warning that a non-loopback bind was wide open. It now warns
  that the setting is inert.
- A fresh `tai init` no longer produces a config that warns at startup: the
  sample `researcher` agent claimed `web_search`, which defaults to disabled.
