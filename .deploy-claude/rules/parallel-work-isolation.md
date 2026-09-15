---
name: parallel-work-isolation
paths: ["**"]
skills: []
scripts: []
---
# Rule: parallel work goes in its own worktree

Scope: whenever work runs alongside other work in this repo — a second
agent, a background task, an experiment you want to keep separable.

- **One working tree per line of work.** `git worktree add ../<repo>-<what> <branch>`.
  Two agents editing one tree produce a diff neither of them authored and
  a receipt that covers work nobody reviewed.
- **The task that spawned it owns it.** Remove the worktree when the work
  lands or is abandoned: `git worktree remove <path>`. A stale worktree
  is a second repo drifting quietly out of date.
- **Never share a worktree to save setup time.** The cost of a wrong
  merge is paid once and forever; the cost of a worktree is seconds.
- **The harness does not enforce this** and no check will fail on it.
  It is a rule because the failure it prevents is silent: the damage
  shows up later as a diff nobody can account for.

If you genuinely cannot isolate — a tool that only runs at the repo root,
a build that will not relocate — say so in the task order's out-of-scope
before starting, not after the collision.
