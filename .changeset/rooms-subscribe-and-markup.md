---
"@tailored-ai/core": patch
---

rooms: stop `invite` undoing a wake mode, and stop posting raw tool-call markup

Three fixes found by auditing what agents actually said:

- **`invite` and `/room add` no longer reset an existing subscription's wake
  mode.** Neither takes a wake mode, so both wrote their own default over
  whatever the agent had chosen: an agent set itself to `all`, someone invited it
  to the room it was already in, and it dropped back to `named` — while the
  `subscribe` call that set `all` had truthfully reported success. Re-inviting is
  now a no-op on wake policy; only a call that names a mode changes one.
- **Raw tool-call markup is corrected rather than posted.** A local model emitted
  `<tool_call> function=room> <parameter=action> post …` as prose and it went
  into the channel verbatim. It now gets the same one-round correction as a
  written-out `pass`, and is suppressed with a log line if it survives that. The
  message it meant to send is visible in the markup, but digging it out means
  parsing one model family's dialect and guessing — a wrong guess posts words the
  agent did not choose, under its name.
- **Agents subscribed to a room without the `room` tool are named at startup.**
  Every wake prompt ends with "call `room(action="pass")` if you have nothing to
  add", which an agent whose `tools:` list omits `room` cannot do — so it types
  the instruction as prose, and from outside that looks like a model too weak to
  make a tool call. Four agents in one deployment were in this state, including
  the busiest. Warned, not auto-granted: withholding a tool is a config decision.
