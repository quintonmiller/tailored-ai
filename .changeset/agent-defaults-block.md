---
"@tailored-ai/core": patch
---

Add `agent.defaults` — deployment-wide fallbacks for every per-agent field.

A setting whose right value is the same for every agent had to be written on
every agent, and the ones added later silently kept core's default. The omission
is invisible: the agent resolves fine and takes a value nobody chose.
`roomSessionScope` is the worked example — in a 32-agent deployment 27 set it to
`shared` and 5 said nothing, and one of those five was the agent whose whole
value is remembering a subsystem. A direct message to it opened a session
holding none of what it had learned, and it answered by reading back an
unrelated block of injected state.

Precedence is `agents.<name>.<field>` → `agent.defaults.<field>` → the legacy
deployment-wide field where one exists → core's default, so a deployment can
migrate onto the new block without editing every agent first. Applies to agents
from `config.yaml` and from the agent registry alike.

Identity fields (`tools`, `skills`, `instructions`, `model`, `provider`,
`models`, `description`, `contextDir`, `online`) are rejected with a validation
warning that names the reason, rather than silently ignored.
