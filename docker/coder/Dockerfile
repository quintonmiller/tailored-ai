# Sandbox image for the TAI coder/reviewer agents.
#
# The container hosts `pnpm`, `git`, and `bash` — everything the per-task
# coder needs to compile, test, and commit. The agent's worktree is bind-
# mounted at /work; pnpm-store is bind-mounted read-only so the worktree's
# node_modules symlinks resolve without re-installing on every dispatch.
FROM node:20-alpine

# - git for commits/diffs
# - bash because the agent's exec tool runs `bash -c <command>`
# - openssh-client / ca-certificates so https git ops resolve TLS roots
#   (skip-push is the default but the model may still web_fetch over https)
# - Tini for proper signal handling on `docker stop`
# - github-cli so the reviewer agent can `gh pr create` on approve.
#   github-cli is in alpine's community repo. Reads GH_TOKEN from env at
#   call time — host wires that through the sandbox env block.
# - grep/coreutils/findutils install the GNU variants over busybox's, so the
#   model's GNU-isms (`grep --include`, `grep -r`, GNU `find`/`sort`/…) work
#   instead of erroring with "unrecognized option".
RUN apk add --no-cache git bash openssh-client ca-certificates tini github-cli grep coreutils findutils

# Authenticate HTTPS git operations with GH_TOKEN. The reviewer pushes via gh,
# but the coder may run raw `git fetch`/`git push`, which otherwise prompt for a
# username and fail non-interactively ("could not read Username for github.com").
# The token is read from the env at call time (host wires GH_TOKEN through).
RUN git config --system credential."https://github.com".helper \
    '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'

# pnpm: install globally via npm (system-wide, world-readable) and
# DISABLE corepack. Corepack-managed pnpm was unreadable when the
# container runs as the host uid:gid (corepack's cache lives under
# /root). It also auto-fetches whatever version the project declares,
# which has bitten us when newer pnpm needed a newer Node than this
# image ships. A static install in /usr/local/bin is the simpler path.
# If you bump pnpm, bump root package.json's packageManager too and
# rebuild the image: `docker build -t tai-coder:latest docker/coder`.
# typescript is installed globally so a bare `tsc` resolves (the model often
# types `tsc` instead of `pnpm exec tsc`). Workspace typechecks still run the
# project's own TS via `pnpm typecheck`.
RUN corepack disable && npm install -g pnpm@10.27.0 typescript@5

# The worktree's node_modules is a symlink farm pointing into the shared
# pnpm store on the host. We bind-mount the store at /pnpm-store, so set
# the env so pnpm uses that path inside the container.
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PNPM_STORE_PATH="/pnpm-store"
ENV PATH="${PNPM_HOME}:${PATH}"

# /work is where the task-watcher bind-mounts the agent's worktree.
WORKDIR /work

# `docker run --entrypoint sleep ... infinity` is how the ContainerSandbox
# keeps the container alive between `docker exec` calls. Tini wraps it for
# clean signal handling.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "infinity"]
