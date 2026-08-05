---
"@tailored-ai/google-tools": patch
---

A missing `gog` binary is reported as a missing binary, not as a Gmail failure.

Every tool in this package shells out to the `gog` CLI and reports failures as
`stderr || "gog <verb> failed"`. A spawn failure produces **no stderr**, so the
fallback fires and an agent is told `gog gmail search failed` — which names the
wrong subsystem and reads as an API or credential problem.

What that cost in one deployment: six days of a monitoring room diagnosing an
OAuth token. The first failures genuinely were `oauth2: "invalid_grant"`, with
gog installed and its credentials expired. Later the binary went missing, stderr
went empty, the message silently changed to the generic one, and five successive
diagnoses kept chasing the token because nothing ever said the command did not
exist.

ENOENT and EACCES now surface as their own messages, the ENOENT one stating
outright that this is not an authentication problem, and pointing at install plus
`gog auth login`. Ordinary non-zero exits are untouched — gog's own stderr is
still the better message when gog actually ran.
