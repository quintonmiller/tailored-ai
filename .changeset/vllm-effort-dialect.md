---
"@tailored-ai/core": patch
---

Add a `vllm_effort` thinking dialect, so a template that reads
`chat_template_kwargs.reasoning_effort` can be asked for something other than
its default.

The existing `vllm` dialect sends `enable_thinking` only — an on/off switch,
which is all older Qwen templates read. Newer ones also take an effort rung, and
their default is the *top* one. Without a dialect that can name a rung, such a
model can only ever be run at its most expensive setting: measured on Qwen3.8,
that is roughly twice the output tokens of `medium`.

It is a new dialect rather than an addition to `vllm` because a template that
does not declare the kwarg either ignores it or raises, so sending effort to
every vLLM endpoint would break endpoints that work today. `effortTemplateMap`
also translates core's `high` to the template's `xhigh` — the templates that
read this kwarg accept `low`/`medium`/`xhigh` and reject anything else with a
400, so forwarding `high` unchanged would fail every request.

Select it with `providers.<id>.thinkingDialect: vllm_effort`. The eval CLI takes
it as `--thinking-dialect vllm_effort --thinking medium`.
