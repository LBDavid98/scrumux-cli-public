---
name: implement-sop
description: The SOP for implementing a sprint task in this harness - framed by task-brief, verified by task-verify, closed with a receipt rather than a narration. Use whenever implementing any coding task.
---

# Implementation SOP

Two scripts bracket the work: `scrumux task brief` opens (gates + context),
`scrumux task verify` closes (evidence). Their exit codes decide, not your
impression (boundary 5).

Copy this checklist:

```
Implementation Progress:
- [ ] 1. task-brief — gates pass, frame stated
- [ ] 2. In progress via scrumux; implement within scope
- [ ] 3. Document per D-0006
- [ ] 4. Unit tests afterwards, same task
- [ ] 5. task-verify — exit 0, receipt written
- [ ] 6. Receipt log; in_review
```

**Step 1 — run exactly:**

```
.claude/scripts/scrumux task brief T-XXXX
```

- **Exit 2**: a gate failed (not in a ratified sprint / another task
  in_progress / no task order). Each FAIL line names its fix. Do not
  start. `--allow-unsprinted` exists ONLY for User-directed bootstrap.
- **Exit 0**: state the frame in one message — sprint, task, acceptance
  check, verification command — then continue.

The brief's reading list IS your context (D-0005): open those files for
those reasons. It also prints the law bearing on the file set and, for
every file the order CHANGES, the code graph's callers and callees —
who breaks if you touch it, and what it leans on. Read that before the
first edit, not after the first red suite. If implementing still needs
a search, the order is incomplete — stop, fix the order, re-brief.

**Step 2.** `scrumux task status T-XXXX in_progress` (scrumux enforces
one-at-a-time). Implement inside `--scope`; the OUT list is binding.

**Where you work.** Run commands from the repo (or worktree) root, and call
the CLI as `.claude/scripts/scrumux` — `../.claude/scripts/scrumux` from a
subdirectory matches no allow rule and is refused. Throwaway files — an
export to diff, a probe script — go in `.scratch/` at that root: it is
gitignored, and `rm -rf .scratch/<name>` is allowed (D-S040). Scratch
anywhere else is left for the operator to keep out of a commit, and a
recursive delete of it is refused.

**Before filing, look.** `scrumux issue find '<words or a path>'` searches
every issue; `scrumux issue list` shows the open ones. The journals are
`governance/*.json` under GOV_ROOT — in a dispatched worktree that is the
main checkout, not the worktree's stale copy — so read them through the CLI
(`issue list`, `log show L-XXXX`, `task brief`), never by searching the disk.

Something **broke** outside scope — you saw it behave wrong and can name
the command that shows it: `scrumux issue new --type defect --source implement-sop
--summary ... --fix ...`, one line, then keep moving. Never fix it in-line
(boundary 3), and never go looking for more. Something merely untidy,
inconsistent or improvable is **not filed at all** (D-0079).

The report is read by a validator who was not there, so it carries the
site and the repro. One real capture, verbatim (I-0153):

```
.claude/scripts/scrumux issue new --type harness --source implement-sop \
  --summary "harness deploy seeds no .gitignore lines for the views scrumux writes, so running a report dirties a deployed repo's tree. Repro: deploy into a git repo, commit, run scrumux views render, git status shows four untracked generated files." \
  --fix "deploy appends the ignore lines for exactly what views render writes into the target's .gitignore, once: append-only and append-if-absent, so a second deploy adds nothing and an existing file is never rewritten."
```

`--summary "deploy is broken"` is not a report — no site, no repro,
nothing a validator can confirm or refute. `--fix "fix it"` bounds
nothing, so the next session picks its own scope.

If the CLI genuinely cannot express what the task needs, say so to the
human and stop. Do not work around it, and do not build a way around it —
the harness is frozen and it is not the job.

**Stub-and-park (D-0015)** — when an out-of-scope blocker halts the task
itself: raise the blocker as a scrumux issue, then stub the blocking
boundary with a grep-able marker naming that issue — `STUB(I-XXXX)`
verbatim in a comment at the stubbed site — and keep building against
the stub. task-verify may pass with a marked stub in place; that is the
lane working, not a cheat. session-check tracks every live marker (WARN
while the linked issue is open) and FAILs any marker whose issue is
resolved, rejected, or unknown — de-stubbing is the linked issue's fix,
never a drive-by. For LLM-call boundaries this is D-0019's "stubbed"
lane: a marked stub is discipline; a silent mock is not.

**Step 3 — document** (D-0006): docstrings on public functions/modules
(purpose + constraints); inline comments only where the code cannot say
why; README/docs updated when user-visible behavior changes.

**Step 4 — tests afterwards, same task.** Write unit tests for the new
behavior after implementing it. No mock LLM calls — real gateway calls
or skip once proven (D-0001 applies to test traffic too).

**Step 5 — run exactly:**

```
.claude/scripts/scrumux task verify T-XXXX
```

It runs the task's verification command plus the covering repo-health
checks, prints an EVIDENCE block, and **writes the receipt onto the
task**. The receipt is the artifact acceptance reads — `scrumux task accept`
refuses a red one — so a verify you did not run leaves nothing for
User to accept.

- **Exit 1**: stay in_progress. If the cause isn't obvious, dispatch the
  **debugger agent** (read-only, D-0007) and implement its proposed fix
  — never patch around a failure you don't understand. Then re-run.
- **Exit 0**: continue.
- **The check needs a step only the operator can take** (a deploy you cannot
  run, a credential you cannot read): commit your work, then
  `.claude/scripts/scrumux task status T-XXXX blocked --reason "awaiting operator: <the exact step>"`
  and stop. Do not wait in a loop and do not fake the step — the operator
  sees the reason in the app, takes the step, verifies and moves the task on.

**A green receipt is not a check that proves its claim (§4b).** Before
you hand the task back, apply the reader's question to your own verify
command: *what is the weakest artifact that passes it — would I accept
it?* If a wrong or hollow artifact passes, the command is a proxy — fix
it to test the real property, or stop the check claiming what it cannot
reach. Worked example: a check that a form's WHERE clause is built by raw
concatenation is NOT proven by a command that only confirms a benign
input returns one row — a safe parameterized form passes that
identically; it needs a command where an injected value behaves as
injection: extra rows, or a syntax error tied to the injected quote.
Record your answer in Step 6's `--did`; the harness holds it as attested,
never verified (§15h), and a second party reading the work is the
backstop.

Five hollow greens that shipped in a real build, each caught only by an
operator probing by hand — check your own suite for every one:

- **It skips when its dependency is down.** A conftest that turns
  "unreachable" into `pytest.skip` exits 0 with the service stopped
  ("2 passed, 3 skipped"). Make the missing dependency a FAILURE that names
  how to bring it up, and run the command once with the dependency down.
- **The assertion cannot fail.** "The vault is not unreachable" passed on a
  404, because a dropped Host header reached the wrong door. Assert the
  positive outcome (the listing came back), and prove the negative once
  (a bad token turns it red).
- **It writes into real shared data.** A test that left empty folders in the
  real vault on every run — and acceptance RE-RUNS your command, so verifying
  polluted it again. Use a throwaway target, or clean up what you create.
- **Its "nothing remains" check enumerates what it expects.** A cleanup check
  that looks only for the ids its run created cannot see the folder or source
  document it did not expect to leave behind. Snapshot the shared store before
  the run and diff it after — and after an interrupted run, whose litter no
  teardown covers.
- **It asserts over nothing.** A search that returned `[]` makes "every hit is
  labelled" pass. Assert the input is non-empty before asserting over it.

If the order states `MUST FAIL WHEN` (`task order --fails-when`), show that
case going red before you call the check green, and say so in `--did`.
**Prove it in a form the allow-list runs.** Claude Code matches command
TEXT and strips only a few known-safe variables, so `VAR=bad uv run …`,
`env VAR=bad …`, `export VAR=bad && …` and `bash -c …` match no allow rule,
by design. Instead: a test that sets the bad value itself (a fixture, a
parameter), or a wrapper under `scripts/` that sets it and runs the real
check, run as `bash scripts/<name>`. A syntax check is such a wrapper too
(`bash -n` inside it), never `bash -n scripts/x` typed directly. If no
runnable form exists, say so in `--did` and let the operator prove it.

**A refused command is a stop, not a puzzle.** Record the exact command and
refusal (`scrumux issue new --type harness --source implement-sop --summary
"<command> refused: <text>" --fix …`), set the task blocked with that reason,
and stop. Trying `bash -n x`, then `/bin/bash -n x`, then `env bash -n
x`, then `bash -c "echo hi"` "to see whether bash is gated" **is** probing,
whatever the intent.

**Step 6 — close with a receipt, not a narration:**

```
.claude/scripts/scrumux log new --task T-XXXX --title "..." \
  --did "<verify command + rc, git diff --stat, every refusal you hit>" \
  --verified "<the EVIDENCE block, verbatim>"
.claude/scripts/scrumux task status T-XXXX in_review
```

`--did` carries evidence: what the verify printed, what the diffstat
says, which gates or walls refused you and what you did about it. It
does not carry a story about the work. Composed prose belongs in the
order that framed the task and in what you say to User — not
in the ledger, where nobody can check it.

One real entry from this repo, verbatim, as the shape to copy (L-0285):

```
.claude/scripts/scrumux log new --task T-XXXX \
  --title "The prune stopped eating the two files deploy promises never to overwrite (I-0152, I-0153)" \
  --did "harness deploy's seeding lane creates .claude/rules/project-standards.md and .claude/project-walls.conf create-if-absent; the I-0143 prune then removed any path the previous manifest names that payload.list lacks. Fixed by writing each seeded path into TMPD/seeded.list and skipping it in the prune. sh tests/harness-tests.sh rc=0; 3 files changed, 61 insertions." \
  --verified "Planted first: 11 new assertions in tests/harness-tests.sh shown FAILING against 444dfd1 in a detached worktree, including 'deploy DESTROYED .claude/rules/project-standards.md because a previous manifest claimed it'. After the fix: harness-tests exits 0." \
  --pending "seals.json is a record records-check reads and is correctly left out, so the first views render on a never-sealed target still leaves that one file untracked"
```

Read the three fields against the bad version of each:

- `--title "fixed hook"` — eight words of jargon naming neither the hook
  nor what stopped being wrong. A title says what changed, and names the
  ids it settles.
- `--did "created X, verified Y"` — nothing there can be checked by a
  reader who was not present. Name the command, its rc, and the diffstat.
- `--verified "tests pass"` — the EVIDENCE block goes in verbatim. A check
  shown failing *before* the fix is worth more than one green from the
  start.

`scrumux help log` prints this again, and the refusal on a missing
`--title` or `--did` carries it too.

Acceptance is User's alone (boundary 2) — `scrumux task accept
T-XXXX --authority ...` only on their word, and it reads the receipt. Done
means the acceptance check passed, not that the output looks done.
