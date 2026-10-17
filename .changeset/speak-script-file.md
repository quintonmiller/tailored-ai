---
"@tailored-ai/speech": patch
---

Let `speak` read a long script off disk

`script` requires the whole screenplay back as a JSON array in the tool call. For
a real one that is the model re-transcribing its own output: a 113-line script
has to come back perfectly, every line, or the recording is subtly wrong in a
way only listening reveals.

Observed in a live deployment: an agent with a finished 6.8 KB script spent turn
after turn reading it back in fragments through `exec` — the output truncated,
so it re-read chunks — and never reached the point of speaking it. The script
was done for over an hour and no audio existed.

`scriptFile` takes a path. Lines are `SPEAKER: what they say`; act headings,
scene notes and blanks are skipped and counted, so a script that parses to half
its length says so rather than quietly recording half a show. Consecutive lines
from one speaker are joined into a single utterance, since a paragraph break is
not worth re-priming the voice for.

The model then supplies only what it actually knows — which voice each character
gets — and the text travels as text. Casting is unchanged: a speaker with no
voice is still refused rather than rendered in somebody else's.
