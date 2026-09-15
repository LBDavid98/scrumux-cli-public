---
name: session-open
description: Opens a working session in this harness. A session IS a sprint (D-0073) - open a thin one, fill it with app-packaged orders or with light tasks minted from User's messages, then work begins on their ratification. Use when a session has no ratified sprint, when User asks to start work, or when there is no ratified sprint to work under.
---

# Session open

A session is a sprint. You open it and fill it; User ratifies
(D-0004, boundary 2). There is no planning ceremony here — backlog, ranking
and triage are the app's surface and User's, never an agent's
(D-0073).

```
Session Open Progress:
- [ ] 1. Open a thin sprint
- [ ] 2. Fill it — app lane, or light lane from User's messages
- [ ] 3. Attach graph context to every order you mint
- [ ] 4. Present it; ratify ONLY on User's word
```

**Step 1 — open a thin sprint.**

```
.claude/scripts/scrumux sprint new --epic E-XXXX
```

It prints the sprint id and nothing else. Empty is the correct starting
state — a sprint is a container for this session's work, not a plan
assembled in advance. Urgent validated issue instead of an epic:
`scrumux sprint new --hotfix --issue I-XXXX`.

**Step 2 — fill it. Two lanes, and you will know which one you are in.**

*App lane.* The order arrives prepackaged — scope, story, out-of-scope,
verification command, full context pack. You add it:

```
.claude/scripts/scrumux sprint add SP-XXXX T-XXXX
```

`scrumux sprint add` refuses an incomplete order. A refusal is the order
being wrong, never a thing to override.

*Light lane (standalone, D-0073).* No app: the work arrives as a message
from User. Turn each discrete piece of it into one task.

```
.claude/scripts/scrumux task new --title "..." --check "<how we will know it is done>"
.claude/scripts/scrumux task order T-XXXX --light \
  --scope "<what this changes, in their words>" \
  --verify "<the ONE command that proves the check>" \
  --out "<what must not be touched>" \
  --file "<path> | <why this file>" \
  --command "<ground truth to run before assuming>"
.claude/scripts/scrumux sprint add SP-XXXX T-XXXX
```

**Write the values for the session that reads them cold.** This is the
step where a backlog turns into a wall of ids: eight-word titles, and
checks vague enough to argue. One real task from this repo, verbatim, as
the shape to copy:

```
.claude/scripts/scrumux task new \
  --title "The close is not blocked by bytecode" \
  --check "A tree containing __pycache__, .pyc, .pytest_cache or .DS_Store files closes session-check exit 0 when everything else traces to a worked task, an unauthorised source file still FAILs by name, and tests/session-check-tests.sh exits 0"
.claude/scripts/scrumux task order T-0217 --light \
  --scope "Add build and OS artefacts to session-check's scope exemption at :202, alongside governance/*, *.MD, .claude/* and .gitignore. Reproduced in canon acceptance run 4 — the close FAILed on agents/__pycache__/*.pyc and the agent had to remove them by hand before it could finish." \
  --verify "sh tests/session-check-tests.sh" \
  --out "Any other exemption. Only build and OS artefacts — a file an agent wrote is still a file an order must own" \
  --file ".claude/scripts/session-check | :202, the exemption case" \
  --file "tests/session-check-tests.sh | both directions"
```

Three tests to apply to your own values:

- **A title states what will be TRUE when it is done** — "The close is not
  blocked by bytecode", not "fix session-check". A file and a verb tell a
  cold reader neither what was wrong nor how anyone would know it stopped
  being wrong.
- **A check is settled by a command, not argued** — it names the
  observable condition AND the suite. "works" and "tests pass" are not
  checks: neither says what would have to be false for it to fail.
- **A --file why says what to look FOR** — ":202, the exemption case", not
  "the session-check script". Restating the filename adds nothing.
- **Say what must make the check fail** — `--fails-when "the vault is down, or
  the probe gets a 404 instead of the listing"`. A verify that skips when a
  dependency is down, asserts something that cannot fail, or writes into real
  shared data is green and proves nothing; the stated failure case is what
  the implementer proves and what the operator reads at acceptance. Write it
  so it can be proven in a form the allow-list runs — a test that sets the bad
  value itself, or `bash scripts/<wrapper>` — never as `VAR=bad cmd`, which no
  allow rule matches.
- **A --file can be a READ** — `--file "governance/log.json | read: L-0004,
  the export procedure"` or `--ref L-0004`; the brief inlines cited log
  entries. When lint TELLs about a path in the prose, list it; do not delete
  the pointer the next session needs.
- **A sprint that touches deploy files gets a deployed check.** When the work
  changes `compose.yml`, a `Dockerfile` or what an image ships, plan one task
  whose check runs against the deployed stack. Checks run from a host
  checkout pass while the deployed image is broken.

`scrumux help task` prints these again at the point of use, and every
refusal on a missing value carries one.

Distil scope, check and verify from what they wrote — do not invent
requirements they did not state, and do not ask them to restate them.
`--light` marks the order so `scrumux task lint` reports its missing story and
thin reading list as TELLs rather than FAILs, and `sprint add` takes it
storyless.

**What --light does NOT relax (D-0072 boundary 4):** the acceptance
check and the single verification command. Light tasks included. If you
cannot say what proves it done, the task is not ready — ask them, do not
mint it.

**Step 3 — attach graph context at mint time.** For every file the
message names, run the two code-graph queries and put their answers into
the order. This is the whole reason a light order is still worth
reading:

```
.claude/scripts/scrumux graph code callers <file>     # who breaks if this changes
.claude/scripts/scrumux graph code callees <file>     # what this leans on
.claude/scripts/scrumux graph gov bearing --file <file>   # the law that binds it
```

Feed the answers back in as `--command` entries (so the implementer
re-runs them against current truth) or as named paths in `--file`, and
name in `--scope` anything the callers list makes clearly in or out.
Nothing here consults a model — it is traversal over a cached index
(D-0001, D-0043). If a query fails, say so in the order rather than
leaving the gap silent.

`scrumux task brief` prints the same two queries for every file the order
changes, so the implementer gets this again at open. Attaching it here
is what makes the ORDER honest about its blast radius.

**Promoting an issue.** An issue only becomes a task once a validation
verdict is on record, and the identity that validates must not be the
one that raised it (issue-validation rule; `scrumux` holds the
disjointness). Dispatch the **issue-validator** agent
(`.claude/agents/issue-validator.md` — read-only), record its verdict
with `scrumux issue validate I-XXXX --verdict ... --evidence ... --by
issue-validator`, and record its `memory-append:` block with
`scrumux memory add --by issue-validator` — the agent is read-only and its
memory persists no other way.

**Step 4 — present and ratify.** Show User the sprint: each
task with its acceptance check and verification command, in the order you
intend to work them, plus anything from their message you deliberately
left out and why. Then:

```
.claude/scripts/scrumux sprint ratify SP-XXXX --by User --authority direct
```

Both flags are required and neither has a default. `--by` names who
ratified — **User** when they say so in session; the agent's
own id only if a recorded delegation put the act in its hands, never as a
stand-in for them. `--authority` is `direct` for their word in session,
`app:<session>` when the Control app carries it, or `standing:D-XXXX`
under a delegation they granted, and the id must resolve.

**Never run this until they say so.** Their word is the event; the command
only records it. Then work the first task — **implement-sop** skill.
