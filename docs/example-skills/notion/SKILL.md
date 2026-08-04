---
name: notion
description: Read and write Notion — search pages, query databases, read a page, create or update pages — using the `ntn` CLI through `exec`, filtering responses with `jq`. Use whenever asked to look something up in Notion, record something there, or when a task references a Notion page or database.
version: 0.6.0
---

# Working with Notion

Deliberately no `allowed-tools`: this skill is attached to every agent, and
under progressive loading a partial list is a hard allowlist that would silently
revoke everything not named — including `room`, without which a woken agent
cannot reply at all.

## What you have

The `ntn` CLI, run through `exec`. It is installed — you do not need to check.
Its `api` subcommand is a thin wrapper over the Notion REST API, and `-d` takes
the request body as JSON:

```
ntn api v1/search -d '{"query":"quarterly plan","page_size":5}'
ntn api v1/users/me
ntn api v1/pages/<page_id>
ntn api v1/data_sources/<data_source_id>/query -X POST
ntn api v1/blocks/<block_id>/children -X PATCH -d '{"children":[...]}'
```

Output is JSON. The method is inferred from the path; `-X` only overrides it.

### Querying a database goes through its *data source*

`v1/databases/{id}/query` no longer exists — it answers `400 invalid_request_url`,
which is easy to misread as a malformed command. Rows live on a **data source**,
and a database id is not a data source id. Fetch the database to get one:

```
ntn api v1/databases/<database_id> | jq -c '.data_sources'
# [{"id":"77e578e1-...","name":"Job Search Pipeline"}]

ntn api v1/data_sources/<data_source_id>/query -d '{"page_size":3}' | jq '.results | length'
```

`v1/databases/{id}` (retrieve), `POST v1/databases` (create) and
`PATCH v1/databases/{id}` (update) all still work. It is only *query* that moved.

**Don't guess at endpoints — ask.** These exist so you don't have to:

```
ntn api ls                       # every supported endpoint
ntn api v1/search --spec         # the parameters for one endpoint
ntn api v1/search --docs         # the full official docs for it
```

Reaching for `--help` on the wrong subcommand, or inventing one like
`ntn pages list`, burns rounds and tells you nothing. `ntn api ls` answers it in
one call.

## Filter before you read

A Notion API response is a large JSON document, and reading one whole into the
conversation costs far more than the answer is worth. You have `jq` — use it.

```
ntn api v1/users/me | jq -r .name
ntn api v1/search -d '{"query":"roadmap"}' | jq -r '.results[] | "\(.id)  \(.url)"'
ntn api v1/search -d '{"filter":{"property":"object","value":"page"}}' | jq '.results | length'
ntn api v1/pages/<id> | jq '.properties | keys'
```

**Never write `2>&1` before a `jq`.** It merges error text into the JSON stream
and `jq` dies with `parse error: Invalid numeric literal` — which looks like the
API returned garbage when in fact your command printed a warning. Let stderr go
its own way; you will still see it if the command fails.

Also available: `cat`, `head`, `tail`, `wc`, `grep`, `cut`, `tr`, `sort`, `uniq`,
`which` and `timeout`. Put `| head -50` on anything you are not sure about before
asking for the whole thing, and `timeout 20 ntn ...` if you have reason to think
a call might sit.

`curl` and `python3` are **not** available to you, deliberately. If a job seems
to need either, it is a job for a human, not a workaround.

## Two constraints that will bite you

**Only those commands run.** The rule is checked at every position in a compound
command, not just the first — so `ntn ... && rm x` fails on the second segment,
not silently halfway through. If a command is refused, do not try to route around
it; say what you were trying to do.

**Notion ids are not titles.** Almost every call needs a page, block or data
source id. If you do not have one, `v1/search` first and read the id out of the
result. Do not guess an id, and do not invent one from a page name.

## Do this

- **Search before you write.** A page with that title very often already exists;
  creating a second one is worse than not writing at all.
- **Say which page you used.** Quote the title and the id in your reply, so
  whoever reads it can check you.
- **Prefer appending to replacing.** `PATCH v1/blocks/<id>/children` adds; a
  `PATCH` on page properties overwrites the property outright.

## Do not do this

- **Do not archive or delete.** `archived: true` is a delete as far as anyone
  reading Notion is concerned. If something looks like it should go, say so and
  let a human do it.
- **Do not treat a failed call as an empty result.** A 4xx means your request was
  wrong; an empty `results` array means nothing matched. Reporting "there is
  nothing in Notion about X" because a call 400'd is how a wrong answer becomes a
  confident one. Read the error, fix the call, or say the lookup failed.
- **Do not paste large page bodies into a room.** Summarise, and give the id.

## The permission you are running under

The token acts as the person who authorised it, across everything it can reach.
There is no per-agent scoping and no separate audit trail — a page edited by you
looks exactly like a page edited by them. Treat write access accordingly: when a
change is not clearly within what you were asked to do, ask first.

The command list is read-oriented with respect to *Notion*, not to this machine:
shell redirection still works, so `... > file` writes a file whatever the list
says. Do not write files as a side effect of a Notion task.
