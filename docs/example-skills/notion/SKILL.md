---
name: notion
description: Read and write Notion — search pages, query databases, read a page, create or update pages — using the `ntn` CLI through `exec`, filtering responses with `jq`. Use whenever asked to look something up in Notion, record something there, or when a task references a Notion page or database.
version: 0.7.0
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

**Every block's text is in `rich_text`, never `text`.** `.heading_2.text[0]`
returns null for every heading there has ever been. Written the usual way —
`.heading_2.text[0].plain_text // "—"` — the fallback swallows it and you get a
page whose headings all render as `—`. That is not an empty page; it is a wrong
jq path, and mistaking one for the other is how an agent concludes its own
finished work never landed. The path is the same for every block type:

```
ntn api v1/blocks/<page_id>/children |
  jq -r '.results[] | "\(.id) \(.type) \(.[.type].rich_text[0].plain_text // "")"'
```

`.[.type]` indexes the payload by the block's own type, so one expression covers
headings, paragraphs, list items and callouts without a chain of `//` fallbacks
to get wrong.

Also available: `cat`, `head`, `tail`, `wc`, `grep`, `cut`, `tr`, `sort`, `uniq`,
`which` and `timeout`. Trim inside `jq` — `'.results[0:20]'` or
`'[limit(20; .results[])]'` — rather than piping to `head`: `head` closes the pipe
early and `ntn` sometimes dies printing a Rust panic about a broken pipe, on top
of output that was actually fine. Use `timeout 20 ntn ...` if you have reason to
think a call might sit.

`curl` and `python3` are **not** available to you, deliberately. If a job seems
to need either, it is a job for a human, not a workaround.

## Writing a page body

**A table is a block type, not a text format.** Notion has no markdown. Writing
`{"type":"paragraph","paragraph":{"rich_text":[{"text":{"content":"| Option | Cost |"}}]}}`
produces a paragraph containing pipe characters — it renders as a line of
punctuation, not a table, and nothing in the response says so. A real one:

```json
{"type":"table","table":{
  "table_width":3, "has_column_header":true, "has_row_header":false,
  "children":[
    {"type":"table_row","table_row":{"cells":[
      [{"type":"text","text":{"content":"Option"}}],
      [{"type":"text","text":{"content":"Cost"}}],
      [{"type":"text","text":{"content":"Notes"}}]]}},
    {"type":"table_row","table_row":{"cells":[
      [{"type":"text","text":{"content":"Finnhub"}}],
      [{"type":"text","text":{"content":"$0/mo"}}],
      [{"type":"text","text":{"content":"60 req/min"}}]]}}
  ]}}
```

Each cell is an **array** of rich-text objects, so `cells` is an array of arrays.
`table_width` and `children` are both required: a table is created with its rows
or not at all, and cannot be filled in afterwards the way a page can. Rows cap at
100 per table, cells at 100 per row.

When a table is more structure than the content deserves, a bulleted list is
honest and renders correctly. A wall of pipes is neither.

**The exact shape of any block is one call away.** Don't reconstruct it from
memory and don't infer it from what a read returned — a response carries fields
(`id`, `created_time`, `annotations`, `plain_text`) that a request will reject:

```
ntn api 'v1/blocks/{block_id}/children' -X PATCH --docs | grep -n 'title: Table' -A 20
```

That is the request schema the server validates against, which is why it settles
arguments about field names that guessing does not.

**Append to the page id, or you will nest by accident.**
`PATCH v1/blocks/<id>/children` adds children *to whatever `<id>` names*. Passing
a paragraph's id tucks the whole section inside that paragraph, where it is
invisible at the top level and looks to the next reader like the write never
happened. Page ids and block ids are the same shape and there is nothing in the
response to tell you which one you used. Re-read the page's top-level children
after writing, and count them.

**Quiet your writes.** A successful `PATCH .../children` echoes every block it
created, in full — tens of kilobytes for one section, all of it content you
already know. End the command with `| jq '{created: (.results | length)}'`.

## Removing blocks

There is no bulk delete: `ntn api v1/blocks/<id> -X DELETE` removes exactly one
block, and clearing a page this way is one call per block.

**Deleting a block deletes everything under it.** So delete the top-level block
and stop — walking into its children to remove them one by one first is work the
parent delete was going to do anyway.

Before rebuilding a page, plan the whole body and write it in one or two calls.
Fifty deletes followed by a rewrite is the same page and a much longer wait, and
each round is a chance to lose track of which id you are on.

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

- **Do not archive a page.** `archived: true` on a page is a delete as far as
  anyone reading Notion is concerned, and it takes the whole body with it. If a
  page looks like it should go, say so and let a human do it. Removing blocks
  *within* a page you were asked to edit is ordinary editing and needs no
  permission — this rule is about losing a page, not about tidying one.
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
