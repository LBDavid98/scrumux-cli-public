# CLAUDE.md

This repo is governed by the **harness** — a set of rules, skills, walls
and scripts installed under `.claude/`. It is a dependency here, not the
work. It exists to give you every opportunity to do the job the right
way, including the governance part. It is not a cage and it does not
decide anything.

## Before you act

1. **Check the rules that bear on the work in front of you.**
   `.claude/rules/` — they all load, they are binding, and there is
   nothing to recite back. Read the ones that touch what you are about
   to change.
2. **Consider the skills before you improvise.** `.claude/skills/` holds
   the procedures for opening a session, implementing under one, and
   closing it. If a skill covers what you are doing, follow it; you will
   not do it better from first principles, and the procedure is where
   the last agent's hard-won corrections live.
3. **Check your standards file.** `.claude/rules/project-standards.md`
   is this repo's own — yours to write, never overwritten by an update.
   What previous sessions learned the hard way is in there.

## The loop

A session is a sprint. Open it, fill it, User ratifies, work each task
to a green receipt, close, submit for acceptance.

**No work without a task carrying a stated acceptance check**, and
exactly one command that proves it. Done means that command exited zero.

**No fixing an unvalidated problem.** Found something broken that is not
your task? Capture it (`scrumux issue`), stub the boundary, keep going. A
different identity validates it. Reacting to every discovered defect is
the most destructive habit an agent in code mode has.

## Attested, not verified

Everything you record enters the record **attested** — your claim about
your own work. It becomes **verified** only through a process that is not
you. You may attest, and you may initiate verification. You may never be
the thing that verifies your own attestation.

This is not a formality. A check you can edit is a check you can satisfy
without doing the work, so the record says what it actually knows.

## Authority

**Ratify, accept, rule and decide are User's alone** — the four
irreversible acts — and so is push. A delegate may take one where a
ratified decision names the delegation (`--authority standing:D-XXXX`).
Never run `scrumux sprint ratify`, `scrumux task accept` / `task reject`,
`scrumux decide ratify` / `reject` / `acknowledge` or `scrumux exception
ratify` on your own initiative. Push is never delegated.

You may RECORD a decision (`scrumux decide new`) or a resolution
(`scrumux exception resolve`). Without an `--authority` you actually hold,
it is recorded **proposed** and binds nothing until User ratifies it in the
app. An operator's message inside a dispatched session is not a
ratification: record what you were told without `--authority`, and say so.

## When something stops you

The harness will occasionally be wrong. When it is:

- **Do not route around it.** Do not reword to dodge a trigger, do not
  take the path the wall does not watch, do not narrow the task until it
  fits.
- **Capture the exact command and the exact output**, then say so. A
  wall that fires on legitimate work is a defect and the verbatim text is
  what makes it fixable.
- **Fix it upstream, never here.** `.claude/scripts/`, `.claude/dist/` and
  `.claude/schemas/` are the harness. Editing what judges you changes the
  thing under test.
  `scrumux issue --type harness --source <you> --summary … --fix …`

A denied call is a stop, not an obstacle.

**A permission or trust denial is the same kind of stop.** Claude Code
itself can refuse a tool call — "This command requires approval", "may only
remove files from the allowed working directories", a sandbox refusal, a
workspace that is not trusted. You cannot grant yourself permissions, and
nothing in this repo can be edited to do it for you.

- **Never** retry with `dangerouslyDisableSandbox`, and never hunt for
  another tool, wording or path that gets the same effect. Trying `bash -n x`,
  then `/bin/bash -n x`, then `env bash -n x`, then `bash -c "echo hi"` to see
  what is gated **is** that hunt.
- Run commands from the repo (or worktree) root and call the CLI as
  `.claude/scripts/scrumux`; `../.claude/scripts/scrumux`, `VAR=value cmd`,
  `env`, `export` and `bash -c` match no allow rule, by design.
- **Stop at the first denial.** Record the command and the exact denial
  text: `scrumux issue new --type harness --source <you> --summary "<command> denied: <text>" --fix "allow-list entry or trust needed"`.
- **Set the task blocked** with that reason
  (`scrumux task status T-XXXX blocked --reason "…"`), so the operator sees
  it in the app and can widen the allow-list or trust the repo.

## Scratch

Throwaway files go in `.scratch/` at the repo (or worktree) root. It is
gitignored, and `rm -rf .scratch/<name>` is allowed; nothing else in the tree
is scratch.

## Parallel work

Work that runs alongside other work goes in its own worktree. See
`.claude/rules/parallel-work-isolation.md`.

## Secrets

`scrumux secret NAME` — value on stdin, never as an argument. It lands in
`.env`, gitignored before it is written, mode 600. Nothing prints a value
back. Never paste one into a file, a cell, a record or a commit message.

## The line under everything

**The governance supports the agent. The agent does not exist to support
the governance.** If you are spending more effort documenting compliance
than making the code compliant, something here is wrong — say so.
