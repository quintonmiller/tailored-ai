---
"@tailored-ai/cli": patch
---

`scripts/tai-ctl.sh` gains an instance dimension, so one machine can hold a work and a personal deployment.

Instances are declared in `~/.tai/instances.conf` as `name=/path/to/home`; the file is created on first run holding the single instance that already exists. `-i <instance>` is now required by every command that touches `agent` or `ui`.

- pid and log files for `agent`/`ui` are namespaced per instance. `vllm` stays shared — one model server serves every instance — and is no longer in the default target set, so restarting an agent no longer reloads a 27B model.
- The agent is spawned with a scrubbed environment (`env -i`) carrying an explicit `TAI_HOME`. The scrub is the point: `dotenv` does not overwrite a variable already in the environment, so a `DISCORD_TOKEN` exported in the invoking shell would outrank the instance's own `.env` and log the wrong bot in with no error anywhere.
- Only one instance may hold the `agent` slot, enforced by scanning every instance's pid file for a live process. Pid liveness is the only truth, so a crash releases the slot with nothing stale to clean up.
- New `switch -i <instance>` and `instances` subcommands.
- The previous flat `~/.tai/{run,logs}/agent.*` layout is adopted into the first declared instance on first run, so an agent started under the old script stays visible to `stop` rather than becoming an unkillable process holding port 3000.

Note the log path change: `~/.tai/logs/agent.log` is now `~/.tai/logs/<instance>/agent.log`.
