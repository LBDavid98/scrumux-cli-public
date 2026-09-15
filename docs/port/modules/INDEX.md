# docs/port/modules — index and validation record

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

**`docs/port/` is port-lifetime scaffolding — slated for deletion when Phase 6
closes.**

Fifteen module-inspection docs covering every Phase 2–5 port subject, in the
plan's ruled format (Intent / Deliberate looseness / Simplify-perf / Open
questions). Drafted 2026-08-31 by a 15-shard inspection fleet; independently
validated the same day by a 6-validator adversarial panel (82 extracted
claims: **14 confirmed new · 66 already covered · 2 refuted** — both
refutations corrected in place, in `cli-core.md` and `journal-engine.md`).
Each doc still gets the Opus builder's own validation pass before its module
ports — these are drafts that prove ground was walked, not substitutes for
the builder walking it.

| Doc | Port phase | Subject |
|---|---|---|
| `walls-lib.md` | 2 | shared wall library: cmd_words awk scanner, ERE handling, conf, record |
| `block-destructive.md` | 2 | destructive-command wall |
| `block-secret-reads.md` | 2 | secret wall (post-1a behavior = parity spec) |
| `block-upstream-and-llm.md` | 2 | upstream-edit + direct-LLM walls |
| `cli-core.md` | 3 | entry, dispatch, envelope, exit doctrine, flip mechanism |
| `cmd-status.md` | 3 | status×4 incl. the ≤150ms session budget |
| `cmd-records.md` | 3 | records check |
| `cmd-graph.md` | 3/5 | bash side of graph queries |
| `read-verbs-small.md` | 3 | backlog, views, memory, health, secret |
| `journal-engine.md` | 4 | THE write path: locks, guards, seals, jq fidelity |
| `cmd-task.md` | 4 | brief gates, verify/receipt, acceptance conditions |
| `cmd-harness.md` | 4/6 | deploy/verify: payload, manifest, drift, prune |
| `session-sprint-repair.md` | 4 | session lifecycle, sprint ratify, repair |
| `design-nouns.md` | 4 | epic/feature/story/issue/exception/decide/rank/log |
| `python-graphs-schema.md` | 5 | code/governance graphs, schema_check, golden fixtures |

**One Phase-3 subject sits outside this set:** `../UNGOVERNED-GUARD.md`, the
`.scrumux-ungoverned` refusal added after these fifteen were drafted
(`RULINGS.md` R-001, 2026-09-01). It lives in the dispatcher above the
implementation flip, so it belongs with `cli-core.md` when that ports and is
not a module of its own.

## The 14 validated-new findings, triaged under D-0087

D-0087 (User, 2026-08-31) rules the triage: a CLI looseness whose
counterpart is app-side monitoring is **deliberate division of labor** — the
CLI guides the agent and records what happened; scrumux-app observes and
surfaces; nothing blocks or validates direct user input at the CLI. And
batch-approvable items get ONE approval, never a per-item ratification loop.

### Register candidates — deliberate CLI looseness, app observes, port preserves as-is
- `emit ""` prints nothing in human mode — a live, deliberate idiom for
  "the report already said everything" (8+ call sites); rows/data still
  travel under `--json`, which is what the app reads. (`cli.sh:173-175`)
- List accumulators don't dedupe (`epic --feature`, `feature --dep`,
  `story --criterion`, `issue --file/--waives`, `log --pending`) — the CLI
  writes what was said; duplicate refs are an app-surfacing concern.
- `issue --file` performs no filesystem existence check — same division.
- `exception --session/--rule` unvalidated while `--task` goes through
  `require_task_ref` — the asymmetry stands; dangling refs are the app's to
  surface. (`cmd-exception.sh:23-37`)
- `lib.sh:77`'s jq-absent `die` exits 1 where cli.sh's die exits 2 — P-02
  already measures it; holds during coexistence, moot once TS drops jq.

### Already queued for User at the Phase 3 gate (envelope consistency batch)
- `help`/`version` bypass the `--json` envelope entirely (`scrumux:181-193`,
  verified live) — joins the existing PK-1/unknown-noun batch.
- `ts-owns` silent fail-back visibility: proposal to add a stderr line or
  note row (no exit-code change; the ruled "fail BACK to bash, never fail
  the command" is untouched). Rides the same gate since flips start there.

### Phase 6 gate batch (deploy behavior — one approval, per D-0087 rule 2)
- Prune `rm -f`s an old-manifest path with no byte check and no backup
  (`cmd-harness.sh:822-836`); companion proposal: WARN on byte mismatch.
- Deploy is non-transactional — writes land before the terminal records
  check; stated inline at `cmd-harness.sh:906`; companion proposal:
  stage-and-swap.
- ~~`enforcement-posture.md` contradiction: shipped as MACHINERY_DOCS with a
  comment saying a target editing it "is the point," but drift
  classification defaults it to DRIFT_FROZEN, which FAILs verify
  (`cmd-harness.sh:195-199` vs `:1141-1183`).~~ **Off the gate, closed
  2026-09-01:** the file no longer ships. `MACHINERY_DOCS` is empty and the
  census is archived at `docs/history/enforcement-posture.md`. Existing
  targets KEEP their copy — it was target-editable by design, so the deploy
  lane declares it prune-exempt. See `cmd-harness.md` Open Question 1.

### Builder applies during the port (BEHAVIOR-PRESERVING)
- `cmd-session.sh` re-parses `$TASKS` ~11 times and shells out per file in
  the stub scan — one-parse-per-journal in the TS port.

## Caveats on the panel's numbers
Of the 66 "already covered" verdicts, most were covered by the module docs
themselves (the claim list was extracted *from* the docs, so this means
"correctly filed where it belongs," not "redundant work") and ~10 by
in-code comment rulings, PHILOSOPHY items, or D-0085 — those "NEW" labels
were wrong and carry no action. The 2 refutations are corrected in place
and struck through where the wrong proposal needs to stay visible.
