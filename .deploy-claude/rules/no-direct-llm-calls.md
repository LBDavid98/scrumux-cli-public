---
name: no-direct-llm-calls
paths: ["**"]
skills: []
scripts: []
hooks: [".claude/dist/block-direct-llm.mjs"]
---
# Rule: no ungoverned LLM calls

Scope: loads whenever work involves making, wiring, or configuring an
LLM call — code, scripts, curl, SDK usage, or config.

The principle is generic; the destination is this repo's to declare.
Model traffic goes through whatever gateway this repo has declared, so
keys, model policy and spend have one home. Never call a provider
(Anthropic, OpenAI, Google, Mistral, Bedrock, etc.) directly — no
provider API endpoints, no provider SDKs pointed at provider URLs.

- Never invent, paste, or print a token. Reference a secret by path:
  `scrumux secret set NAME`.
- Do not hardcode a model list. Follow this repo's declared model
  policy; where it has none, ask.
- Where no gateway is declared the wall still holds, and the allow line
  below is the only way through.

The wall that refuses it: `.claude/dist/block-direct-llm.mjs`, on shell
commands targeting known provider API domains.

A repo that genuinely must go direct — a course assignment, a vendor SDK
under test, a repo whose gateway IS the provider — declares it once in
`.claude/project-walls.conf` as an `allow` line with a reason. That is
the pathway; working around the wall is not.

This repo's own gateway details, model policy and access procedure
belong in `.claude/rules/project-standards.md`, not here (D-0086).
