---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

Live sessions can give the agent a body to move. A page starting a session may declare one: `POST /api/live/sessions` takes `body: {looks?, gestures, aimed?}`. Voice mode then teaches the agent to write cues inline, such as `<wave/>` or `<go to="the couch"/>`. The spoken turn takes them out before anything is spoken or shown, and streams each as a `cue` event with the `seq` of the sentence it comes before. A cue the body can't do is dropped, never read aloud; `*waves*`-style stage directions are understood too. Tags were chosen by measurement on a 27B local model: 9/10 movement requests done against 8/10 for stage directions, with fewer silent replies and no invented moves.
