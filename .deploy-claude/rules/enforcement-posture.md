---
name: enforcement-posture
paths: [".claude/scripts/**", ".claude/dist/**", ".claude/rules/**"]
skills: []
scripts: [".claude/scripts/scrumux"]
hooks: [".claude/dist/block-destructive.mjs", ".claude/dist/block-direct-llm.mjs", ".claude/dist/block-secret-reads.mjs"]
---

# Rule: refuse only what is irreversible

The constitution in CLAUDE.MD is the authority. It names the only walls —
no destructive command without an attested backup, no secret reads, no
LLM call outside the gateway, no writes to the machinery in a deployed
repo, PreToolUse hooks only — and reserves the four irreversible acts,
ratify, accept, rule and decide, and push, to User. A decision or an
exception resolution an agent records without authority is kept as
proposed for User to ratify, reject or acknowledge; it is not refused.
Nothing else stops a run.

A repo adds a pattern of its own, or exempts one it genuinely needs, in
`.claude/project-walls.conf`. That is the one pathway for this layer;
forking a hook is not.

Before adding a refusal, ask what it costs to be late. If the answer is
not "damage that cannot be undone", it is a **tell**: name the finding
with its fix and let the turn continue. Bookkeeping is not a hazard, and
governance corrections never reach the agent at all (boundary 7) — they
are User's inspection data.

The inspection surface (D-0073) is `scrumux records check`, the health fleet and
the planning views. None of it sits in an agent's path.
