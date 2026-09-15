# Enforcement posture — a historical census of refusal sites

> Archived 2026-09-01 from `governance/enforcement-posture.md`; it was shipped
> to every governed repo as a machinery doc while its own header declared it
> historical. Kept for its per-site reasoning; where it and the code disagree,
> the code is right.

**Status: historical reference. Nothing reads this file mechanically.**

This document carried rule frontmatter (`scripts:`, `hooks:`) that
`validate` section 11 walked to cross-check the table against the code in
both directions. T-0184 deleted that sweep and this file's frontmatter
with it (D-0074, step 1 of the contraction). No anchor is checked, no row
is enforced, and a row that has drifted from the code is stale reference
data — not a finding. Record inconsistency is User-inspection data,
never an agent's block or brief line (D-0072, boundary 7).

The authority on what may refuse is the constitution in CLAUDE.MD:
boundary 1 names the only walls (no destructive command without attested
backup, no secret reads, no LLM call outside the gateway; PreToolUse
hooks only), and boundary 2 reserves ratify, accept and push to User.
`.claude/rules/enforcement-posture.md` is the terse rule that points
there. The rest of the enforcement surface — validate, the health fleet,
gates.json, pendings — is User-inspection (D-0073) and is not in an
agent's path.

`governance/gates.json` is deliberately **unranked**. `gate-cost` is
deleted per D-0074, and the journal records refusals only (D-0071): every
emit site sits on a refusal branch, so a gate that considered and allowed
is invisible and there is no denominator to rank a cost against (I-0105,
measured: 49 rows, 0 pass, 0 waive, never ranked). Do not rebuild a
ranking on it.

The table below is the 2026-08-21 snapshot. It is kept because the
per-site reasoning is worth reading when a gate is being changed, and for
nothing else.

Three dispositions, per D-0058 — **block rarely, tell mostly, log
always**:

- **block** — the run stops. Reserved for the acts that make the record
  false (a self-validated issue, an unlogged finish, a re-accepted
  review) and for the acts that destroy something (the four hooks).
- **tell** — the finding is named with its fix, a `gates.json` row is
  written, and the run continues at exit 0. The default tier for
  anything that is inconvenient rather than untrue.
- **log** — a row is recorded and nothing is said in the turn. Only
  defensible when nobody could act on it now.

**Code anchor** was a literal string that had to still be present in the
named file — how a row proved it described live code while the sweep
existed. Anchors of the form `exit N` mark verdict sites. They are now
descriptive only.

## The table (snapshot, 2026-08-21)

| Site | Owner | Code anchor | Refuses today | Today | Target | Why that tier |
|---|---|---|---|---|---|---|
| `.claude/scripts/scrumux` | `cmd_issue()` | `self-validation refused:` | validating an issue you raised yourself | `block` | `block` | Independent confirmation is the entire content of the validation gate; a self-certified verdict is a false record, not a slow one (I-0054). |
| `.claude/scripts/scrumux` | `cmd_task()` | `an unvalidated issue is not backlog work` | `scrumux task new --issue` on an issue with no verdict | `block` | `block` | Same gate as the hotfix lane, other door (T-0113/I-0056). Promoting an unvalidated claim writes a task whose premise nobody checked. |
| `.claude/scripts/scrumux` | `cmd_task()` | `no silent finishes: $TID has no log entry` | `scrumux task status ... accepted` with no log entry | `block` | `block` | D-0006. An accepted task with no log is a finish that left no trace — the record would say work happened and name nothing. |
| `.claude/scripts/scrumux` | `cmd_task()` | `review before done: $TID has no accepted review` | `scrumux task status ... accepted` with no accepted review | `block` | `block` | D-0006. Acceptance is User's act; a task that reaches accepted without one is the record claiming an authority that never spoke. |
| `.claude/scripts/scrumux` | `cmd_accept()` | `an acceptance is write-once` | re-accepting an already-accepted review | `block` | `block` | I-0042, measured: a mistyped id moved R-0063's acceptance date and T-0061's `updated_at` by a day, and `scrumux session check` reads `updated_at` as evidence of work. |
| `.claude/scripts/scrumux` | `cmd_accept()` | `disposition before acceptance (T-0032)` | accepting a review carrying untriaged findings **only under `--triage-each`** | `tell` | `tell` | Converted by T-0147. The default auto-classifies every undispositioned finding as data, prints each one, and records a `gates.json` tell. The refusal string survives as the opt-in path, which is what keeps this row's anchor real. |
| `.claude/scripts/scrumux` | `cmd_reject()` | `rejection would overwrite a recorded final-authority ruling` | rejecting a review already accepted (sibling arm: already rejected) | `block` | `block` | Overwriting a recorded ruling needs User's explicit reversal, not a second command. The record must not have two answers. |
| `.claude/scripts/scrumux` | `cmd_reject()` | `rejected work resumes immediately` | rejecting while another task is `in_progress` | `tell` | `tell` | Scheduling advice, not truth. Nothing false is written if two tasks are open for a minute — say it and continue (T-0144). |
| `.claude/scripts/scrumux` | `cmd_sprint()` | `hotfix sprints need --issue I-0001` | `scrumux sprint new --hotfix` with no source issue | `block` | `block` | D-0004: a hotfix sprint IS its source issue. Without one the fast lane becomes an unbounded lane. |
| `.claude/scripts/scrumux` | `cmd_sprint()` | `the decision queue is not empty` | `scrumux sprint new --epic` while User decisions are pending | `tell` | `tell` | T-0146/D-0016. Withholding planning does not get the questions answered; printing each pending item in a form User can rule on does. Hotfix exemption (D-0051) unchanged. |
| `.claude/scripts/scrumux` | `cmd_sprint()` | `it was worked, and descoping does not erase them` | descoping a task that already has log entries | `tell` | `tell` | The advice is right and the block is not: the alternatives (complete the sprint around it, or retire the task) are printable, and the descope itself writes a reason (T-0144). |
| `.claude/scripts/scrumux` | top-level dispatch | `exit 1` | an unknown `scrumux` subcommand | `block` | `block` | A mistyped subcommand that returned 0 would let a caller believe a governance write happened. |
| `.claude/scripts/scrumux task brief` | `--- Gates ---` | `is not in any ratified sprint (D-0004)` | briefing a task in no ratified sprint | `tell` | `tell` | `scrumux session check` section 1 is the backstop that actually holds the line at session end; refusing the brief only hides the order from the person who would fix it (T-0144). |
| `.claude/scripts/scrumux task brief` | `--- Gates ---` | `already in_progress. Finish or move it first` | briefing while another task is `in_progress` | `tell` | `tell` | `scrumux task status in_progress` still blocks at the write. Reading an order is not starting work. |
| `.claude/scripts/scrumux task brief` | `--- Gates ---` | `task order: FAIL — none.` | briefing a task with no `task_order` | `block` | `block` | D-0005. There is no brief to print — the context pack is the order, and an order-less brief invites the search it exists to prevent. |
| `.claude/scripts/scrumux task brief` | argument handling | `not found — scrumux task new first` | briefing an id that is in no journal | `block` | `block` | There is nothing to describe; continuing would print a brief for a task that does not exist. |
| `.claude/scripts/scrumux task brief` | verdict | `exit 2` | the run, when any gate above failed | `block` | `block` | Stays 2 while the missing-order gate stays a block; the sprint and one-at-a-time arms stop setting `GATEFAIL` (T-0144). |
| `.claude/scripts/scrumux task lint` | per-task loop | `empty verification_command` | an order with no verification command | `block` | `block` | D-0006. An order that cannot state how it will be proven is a record defect; every downstream gate reads this field. |
| `.claude/scripts/scrumux task lint` | per-task loop | `verification_command looks composite` | a chained verify command (and-and, semicolon, or-or) | `block` | `block` | Atomicity. A composite verify hides which half proved the acceptance check — wrap it in a script and point at that. |
| `.claude/scripts/scrumux task lint` | per-task loop | `names a suite without an interpreter` | `tests/x.sh` with no `sh ` prefix | `tell` | `tell` | D-0041/I-0060 is a portability wart, not a lie: the order says what to run, it just relies on a file mode. Name it and continue (T-0144). |
| `.claude/scripts/scrumux task lint` | per-task loop | `out_of_scope is empty` | an order that names nothing out of scope | `tell` | `tell` | A judgement call about how much was considered and excluded — advisory, like the reading-list completeness warning beside it (T-0144). |
| `.claude/scripts/scrumux task lint` | per-task loop | `context.files empty` | an order with an empty reading list | `block` | `block` | D-0005: the reading list IS the anti-search mechanism. An empty one makes the order unimplementable as written. |
| `.claude/scripts/scrumux task lint` | verdict | `exit 1` | the run, when any rule above failed | `block` | `block` | Stays 1 for the rules that keep failing — an order that lies about its own verification is a record defect. |
| `.claude/scripts/scrumux status` | `--sprint` / `--planning` dispatch | `exit 3` | reporting while a ratified sprint has unfinished tasks | `tell` | `tell` | D-0004 is the rule; this script is a read-only report (the old `sprint-status`, merged by T-0138). It should say which sprint is in flight and let the planner decide, not refuse to report (T-0144). |
| `.claude/scripts/scrumux session check` | section 1 | `worked outside any ratified sprint:` | a worked task in no ratified sprint, unwaived | `tell` | `tell` | The work is already done by the time this runs; the fix (`scrumux sprint add` + ratification, or a recorded waiver) is a next step, not a stop. |
| `.claude/scripts/scrumux session check` | section 2 | `multiple tasks in_progress` | more than one task left `in_progress` | `tell` | `tell` | `scrumux task status` already blocks the second `in_progress` at the write. This is the same rule observed after the fact. |
| `.claude/scripts/scrumux session check` | section 3 | `no log entry for:` | an `in_review`/`accepted` task with no log entry | `block` | `block` | D-0006, the same untruth `scrumux` refuses at the write; this is the backstop for records that reached that state another way. |
| `.claude/scripts/scrumux session check` | section 4 | `no review record for:` | an `in_review`/`accepted` task with no review | `block` | `block` | D-0003/D-0006. A finished task with no review record claims a gate that never ran. |
| `.claude/scripts/scrumux session check` | section 6 | `invalid JSON:` | a governance journal that does not parse | `block` | `block` | Every other check in the harness reads these files. A broken journal makes every verdict in the session unreliable, including this one. |
| `.claude/scripts/scrumux session check` | section 6b | `stub marker(s) whose issue is resolved/rejected/unknown:` | a `STUB(I-XXXX)` marker whose issue is closed or missing | `tell` | `tell` | D-0015 parks debt visibly; a stale marker is bookkeeping drift. The open-issue arm is already a WARN, and the two arms should not sit on opposite sides of the exit code (T-0144). |
| `.claude/scripts/scrumux session check` | section 7 | `failing:$HFAILS` | any registered repo-health check that is red | `block` | `block` | A failing test suite stays a block. The carve-out is the tier of the runner: T-0144 makes `run_health_checks` report a red `lint`-type check as TELL, so linters name their findings without turning the session red. |
| `.claude/scripts/scrumux session check` | section 9 | `suspicious files:` | a `.env`/key/`.pem`/temp file in the working tree | `block` | `block` | The one irreversible act in the session lane. A committed secret cannot be un-published. |
| `.claude/scripts/scrumux session check` | verdict (`res()`) | `exit 1` | the session, when any section above FAILed | `block` | `block` | `res()` is the single tier funnel for every section and the one place T-0133 emits gate rows; the verdict stays a block while any section is a block. |
| `.claude/scripts/validate` | section 9b | `has no repo-health entry` | a `tests/*-tests.sh` with no repo-health check running it | `tell` | `tell` | D-0060: no ratifying decision ever authorised this ratchet, and it is what grew repo-health to 45 checks. Name the suite, print the registration command, do not turn the repo red (T-0145). |
| `.claude/scripts/validate` | `sweep_standards()` | `standard-1 (Python/TypeScript)` | foreign-language source, competing agent frameworks, mock-LLM markers, untrapped fixtures | `block` | `tell` | D-0011: standards findings are data. The `validate --standards` health entry is a `lint`, and a lint's finding reaches the session as a tell (T-0144). |
| `.claude/scripts/validate` | verdict | `exit 1` | the run, when any section produced a finding | `block` | `tell` | The exit code stays 1 for a direct caller and for the compliance monitor's porcelain consumption; the tier that reaches a session is set by `run_health_checks`, where a `lint` becomes a tell (T-0144). |
| `.claude/hooks/block-destructive.sh` | `block()` | `exit 2` | `rm -rf`, disk writes, history rewrites, unbacked DB drops | `block` | `block` | The CLAUDE.MD hard limit, and the one class where being wrong is unrecoverable. A tell arrives after the files are gone. |
| `.claude/hooks/block-direct-llm.sh` | provider-domain match | `exit 2` | a shell command targeting a provider API domain | `block` | `block` | Spend, key exposure and an ungoverned model choice all land before anyone reads a tell. The gateway path is always available. |
| `.claude/hooks/block-secret-reads.sh` | secret-path match | `exit 2` | reading `.env`, keys, `.pem`, credential and secret files | `block` | `block` | A secret read into context cannot be taken back out of it. |
| `.claude/hooks/monitor-compliance.sh` | porcelain loop | `--type drift --source monitor` | nothing — it sweeps, mints a deduplicated drift issue, and exits 0 | `tell` | `tell` | The only log-tier site in the harness, and the agent that just caused the drift is still in the turn that could fix it. T-0148 returns each finding as `PostToolUse` context while keeping every path at exit 0. |

## What the snapshot covered, and what it did not

- **In:** every gate that decided about governance state in the six
  scripts the frontmatter used to name (`scrumux`, `scrumux task brief`, `scrumux task lint`,
  `status`, `scrumux session check`, `validate`), every non-zero exit verdict in
  those scripts, and every hook that denies.
- **Out:** argument-shape refusals inside `scrumux` subcommands — a missing
  required flag, an unknown flag, a malformed id. They refuse a
  malformed command rather than a governance act, no conversion list
  names them, and there are roughly 180 of them. The two top-level
  unknown-subject refusals (`scrumux`'s unknown command, `scrumux task brief`'s
  unknown task) are rows because the mechanical sweep reaches them.
- **Out:** the other health-registered linters — `scrumux graph code index`,
  `scrumux graph gov index`, `scrumux harness verify`. Their tier is set by
  `run_health_checks` like every other check, and their own exit
  contracts belong to the tasks that own those tools.
- **Known limit (while the sweep existed):** the reverse sweep in
  `validate` section 11 was complete for hook denials and for exit
  verdicts, both of which it enumerated from the code. It could not
  enumerate `scrumux`'s `die`-based gates the same way: `die` lives in
  `lib.sh`, and nothing in a `die` line separates the eleven policy gates
  above from the argument checks beside them. The `scrumux` rows were held by
  the code-anchor check alone. The sweep is gone (T-0184), so no row is
  held by anything now.
