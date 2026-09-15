---
name: session-start
description: Interprets the SESSION BRIEF injected at session start (or runs it by hand) and routes to the right skill - the deterministic answer to "where do we pick up?". Use at the start of any session, after /clear or a compact, when the user asks where things stand, or when no SESSION BRIEF is visible in context.
---

# Session start

Orientation comes from a script, not from chat memory (D-0010). The
SessionStart hook injects the brief on startup/resume; in-process
subagents share the parent session and are never briefed.

**If no `=== SESSION BRIEF ===` block is in context, run exactly:**

```
.claude/scripts/scrumux status session
```

Then route on what it says — the brief's lines map to actions:

| Brief line | Route |
|---|---|
| `VERDICT: a ratified sprint has N unfinished task(s)` | Work that sprint: **implement-sop** skill on the next task in its listed order. Do not plan. |
| `VERDICT: no ratified sprint in flight` | **session-open** skill: open a thin sprint and fill it. You may only propose — ratification is User's. |
| `in_progress: T-XXXX ...` | That task was mid-flight. `.claude/scripts/scrumux task brief T-XXXX` before touching anything — its gates and reading list are the resume point. |
| `awaiting User: tasks[T-XXXX ...]` or `proposed-sprints[...]` | Surface these to User early. A listed task is in_review with no acceptance on it and clears only by `scrumux task accept T-XXXX --by User --authority "..."`; a listed sprint clears only by their ratification (D-0076/T-0187). |
| `[DIRTY TREE]` on the commit line | Uncommitted work from a prior session — `git status` and reconcile via session-review before new work. |

State the active sprint before touching code (minimum-planning-
requirements rule) — the brief gives you the sentence to say.

Known limit: headless `claude -p` runs are real sessions and get
briefed too — intended, cold probes should be oriented. The brief costs
~20 lines of context per session; keep it that way when extending it.
