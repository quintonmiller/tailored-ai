---
"@tailored-ai/core": patch
---

Let an agent pass on chatter that is not about its work

The wake prompt offered `room(action="pass")` for three named cases — acknowledging, agreeing, thanking. A model reads the enumeration as exhaustive, so anything outside it gets a reply: given a passing remark from one person to nobody in particular, both models tested answered, and by the letter of the wording they were right.

The measured cost was larger than "one unnecessary reply". A room whose `purpose` explicitly said to stay out of social chatter was overridden seven times in eight — the sentence was beating the room's own stated norm, not merely under-specifying.

Adds a fourth case. Still a list of concrete cases rather than a general "reply only when relevant", because the general permission is the phrasing that gets over-taken.

Not free: on the benchmark's control for the opposite failure — a loose question from a person, which must still be answered — the pass rate went from 8/8 to 5/8. The measurements are recorded next to the wording.
