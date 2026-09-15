---
name: source-implement
description: The SOP for implementing a change in the harness SOURCE repo, where the scrumux governance loop is refused and the coding discipline is all that is left - understand before editing, match the house style, prove the change with a named command, run the suites, keep /docs true, commit locally, never push. Use when implementing any change in this repo.
---

# Implementation SOP — the source repo

This repo builds scrumux and is never governed by it (R-001). There is
no task, no sprint, no receipt and no `scrumux` governance verb here —
the dispatcher refuses them, by design. What remains is the part that was
always doing the work: the coding discipline.

Read `.claude/rules/source-session.md` first if you have not. This skill
does not ship — see `.claude/payload-exclude.list`.

```
Progress:
- [ ] 1. Understand the code before editing it
- [ ] 2. Implement in the house style
- [ ] 3. Name the command that PROVES it
- [ ] 4. Run the suites that cover what you touched
- [ ] 5. Update /docs for any shape change
- [ ] 6. Commit locally, with a message that says what changed
```

## 1. Understand before editing

Open the file and read around the change, not just at it. This repo
explains WHY in long comment blocks at the site, and those comments are
load-bearing: most of them record a specific failure that was paid for
once. A change that contradicts the paragraph above it is a change that
re-buys the incident.

Trace the callers. `grep -rn` for the symbol, the path and the literal
string — a shell dispatcher may build a name, a hook may be wired by
path in `settings.json`, and a suite may resolve a script by its literal
path. If implementing still needs an open-ended search after you start,
you have not finished this step.

**Anything you find along the way that looks broken is a FINDING**, and
findings go to `finding-validator` before they drive an edit — including
one you are confident about. Do not fix it in-line on the way past.

## 2. Implement in the house style

Match what is already there rather than what you would write from
scratch:

- POSIX `sh` in `.claude/scripts` and `tests/`; no bashisms.
- The comment carries the reason, in prose, at the site. A new mechanism
  with no paragraph saying why it exists is half-written.
- One definition per fact. A count derived from a roster, never
  hand-written beside it; a second copy of a contract is a second thing
  to keep in step, and the copy nobody reads is the one that goes stale.
- An error message is the instruction set (Article 5): say what was
  refused, why, and the exact next command.

Stay inside the change you were asked for. Adjacent tidying is a
different change.

## 3. Name the command that PROVES it

Before you claim it works, write down the single command whose exit code
decides, then ask the reader's question of it:

> **What is the weakest artifact that passes this command — would I
> accept it?**

If a hollow or wrong implementation passes it identically, the command is
a proxy and proves nothing. Fix the command to test the real property, or
stop claiming what it cannot reach. Worked example: a check that a query
is built by raw concatenation is NOT proven by a command showing a benign
input returns one row — a safe parameterised query passes that
identically. It needs an input where injection behaves as injection.

New behaviour gets a new assertion, in the suite that owns that area. A
change proven only by "the existing suites still pass" is a change with
no test.

## 4. Run the suites that cover what you touched

The two that decide, in this order:

```
sh tools/parity-suites.sh
npm test
```

`parity-suites.sh` discovers `tests/*-tests.sh` from disk, so a new suite
is picked up by existing. It takes `--only <substring>` to run a subset
and nothing else. A suite that exits 0 having asserted nothing is not a
pass and the runner says so.

A red suite is the answer, not an obstacle. Fix the code, or — if the
suite encodes an expectation that is genuinely now wrong — say plainly
which assertion you changed and why, in the commit message.

## 5. Update `/docs`

Standing duty: **`/docs` describes the shape of the harness and its
dependencies, and a session that changed the shape and left `/docs`
stale is not done.** If you added a mechanism, changed a roster,
renamed a surface or moved a decision, the document that describes it is
part of the change, not follow-up work.

## 6. Commit locally, never push

Commit the complete change with a message that says what changed and
why, naming the ruling if one governs it. Local commits are yours to
make freely.

**Push is the user's alone.** It is never delegated and never inferred
from "commit it".

Report back with: what changed, the command you ran and its exit code,
the diffstat, and anything you decided along the way that they might want
different.
