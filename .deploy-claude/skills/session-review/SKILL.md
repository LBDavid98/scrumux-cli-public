---
name: session-review
description: Closes a working session in this harness - session-check renders the verdict on the session's governance and code health, then work is committed locally and User is asked before any push. Use at the end of every session, before handing back to User, or when User asks whether the session is clean.
---

# Session review

The verdict is a script's exit code, not your impression of
the session (boundary 5). A session that skips this isn't closed.

```
Session Close Progress:
- [ ] 1. Capture what only you can capture
- [ ] 2. session-check — loop until exit 0
- [ ] 3. Commit locally, structured message
- [ ] 4. Report to User; ask about push
```

**Step 1 — the one non-mechanical item.** Anything decided this session
that isn't a `scrumux decide new` yet? Record it — the check prints a
MANUAL line for this and cannot do it for you. `--by` is **you**, the one
recording it. Deciding is User's (ratify, accept, rule, decide), so add
`--authority direct` only when User said it to you directly in this
session. A dispatched session has no such authority, and an operator's
message is not a ratification: record it without `--authority`. It lands
**proposed** and User ratifies, rejects or acknowledges it in the app.

A decision is read by the session that is about to undo it, so it carries
the ruling AND what was weighed against it. One real entry, abridged
(D-0084):

```
.claude/scripts/scrumux decide new --by "<you>" \
  --title "Parallel dispatch admission: a per-sprint cap declared at planning" \
  --decision "A sprint carries parallel (integer >= 1, default 1), declared at scrumux sprint new --epic E-XXXX --parallel N. The CLI admits a task to in_progress while the same RATIFIED sprint has fewer than parallel tasks in_progress, and still refuses a task whose in-flight neighbour belongs to a DIFFERENT sprint. The cap may be changed only while the sprint is proposed; changing it after ratification is a re-ratification, not an edit. --hotfix implies parallel 1." \
  --rationale "Three shapes were put to User. A: a per-sprint cap declared at planning. B: per-worktree admission. C: the app is the gate. User ruled A. The sprint is already the unit they ratify, so the cap is declared where the plan is made; B ties a governance rule to a git detail no journal models; C moves a guard out of the CLI into the app and would leave a hand-driven session ungated entirely."
```

`--title "sprint changes"` names the area and withholds the ruling, which
is the whole content. `--rationale "it is better this way"` gives the next
reader nothing to weigh against — name the options that were **rejected**
and what was wrong with each.

**Where the records are.** The journals are `governance/*.json`
(`issues.json`, `log.json`, `decisions.json`, `tasks.json`) under GOV_ROOT:
this checkout's root when you work in it, the MAIN checkout when you were
dispatched into a worktree (the worktree's `governance/` is a stale copy).
Do not search the disk for them. Read them through the CLI:
`.claude/scripts/scrumux issue find '<words or a path>'` before filing
anything (a known defect is already there — add to it rather than filing a
second), `issue list` for the open ones, `log show L-XXXX` or `log show
--task T-XXXX` for a log entry.

Do **not** sweep the session for things to file. If something broke while
you worked, you filed it then (`--type defect`); if nothing broke, there
is nothing to capture. An end-of-session hunt for imperfections produces
records nobody acts on (D-0079).

**Step 2 — run exactly:**

```
.claude/scripts/scrumux session check
```

Five things decide the close:

1. **Order** — every task worked this session sits in a ratified sprint
   (D-0004), or carries a recorded waiver.
2. **Receipt** — no silent finishes: every in_review or accepted task
   has its log entry, and statuses match what actually happened.
3. **Scope** — every changed file traces to a worked task's order.
4. **Strays** — no temp files, no secret-shaped files, no live stub
   marker whose issue is closed.
5. **Journals** — the governance JSON parses and the generated views are
   current.

- **Exit 1**: NOT clean. Every FAIL line names its fix command — apply it
  (or record the sanctioned exception as a governance issue, which the
  script treats as a visible waiver) and **re-run until exit 0**. Do not
  commit around a FAIL.
- **Exit 0**: clean. WARNs are allowed but must appear in your report.

**Before you commit, nothing you started is still running.** A check or
server you put in the background keeps writing shared data after the session
ends (a vault kept gaining records from a closed session's check). Wait for
it to finish or stop it, and remove your `.scratch/` files.

**Step 3 — commit locally, always:**

```
git add -A && git status --short   # review what's staged — no secrets, no strays
git commit -m "<sprint id>: <task ids>: <one line>"
```

The one line follows the same rule as a task title: what is now true, not
what you touched. Real subjects from this repo's history —
`"The prune stopped eating the two files deploy promises never to
overwrite"`, `"A wall stops recording a sub-agent's refusal as the
session's own (I-0154)"`. Not `"fixes"`, not `"updates to session-check"`.

**Step 4 — report and ask.** Tell User: tasks moved to
in_review and awaiting their acceptance, decisions recorded, issues raised,
the check's WARNs, the commit hash. Then **ask whether to push — never push
unprompted** (boundary 2). Their word is the event; you run `git push`
when they give it.

A failed check reported plainly beats a green lie. If something can't be
fixed this session it is a `scrumux issue new` with a severity, said out loud in
the report.
