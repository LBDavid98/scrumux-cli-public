# PHILOSOPHY.md — the register of deliberate loosenesses

> Pinned at 9c15d04 — file:line references resolve against `git show 9c15d04:<path>`; the tree may have moved.

**Phase 0 deliverable of the bash→TypeScript port. Written 2026-08-31.**

This file is the port's anti-strictness spec. It enumerates every place the
bash harness is **permissive on purpose**, names the ruling or code comment
that established it, and states plainly that porting it stricter is a
regression.

## The absolute rule this file exists to enforce

> **The TypeScript port never adds validation the bash implementation does
> not have. Anything that looks "too loose", "missing a check", or "a bug"
> becomes an entry in the Open Questions section at the end of this file and
> is surfaced upward. It is never fixed quietly, never tightened silently,
> and no `warn` is ever promoted to a `fail` without a recorded ruling from
> User.**

This is not caution for its own sake. It follows directly from three things
already ratified:

- **RULINGS.md Prime Article** — the harness does not block the user;
  every blocking surface answers "who is being stopped?" before it ships.
- **Article 3** — force is reserved for destruction and the forceful surface
  stays minimal; a proposal adding a fifth blocking surface carries the
  burden of proving an irreversible act it prevents.
- **Article 8** — a mechanism pays for itself in incidents *prevented*, not
  incidents *imaginable*.

A port is exactly the moment a system silently acquires strictness. The
porter reads a `|| :` and reads it as an oversight; reads a `return 0` on a
failed write and reads it as a swallowed error; reads `additionalProperties`
handled only when literally `false` and reaches for ajv. **Every one of those
would be a regression against a ruling.** The differential harness would then
certify the regression, because the TS side would refuse where bash passed
and the diff would be attributed to "TS is more correct".

The backstop, stated here and enforced in Phase 1 by lint: every failure or
refusal in the TS implementation traces to a bash counterpart or carries
`// APPROVED-DIVERGENCE: D-nnnn`. And the property test: **TS never fails
where bash passed**, over the whole corpus, every verb.

## How to read an entry

Each entry carries:

- **What is loose** — the behaviour, stated as behaviour.
- **Where** — `file:line` in this repo at the commit this was written
  against, plus the ruling or incident that established it.
- **Port note** — what a faithful port must do, and the specific stricter
  thing a porter will be tempted to write instead.

Line numbers were read from the tree on 2026-08-31 and are given for
orientation; the surrounding comment is the durable citation.

## Companion documents

| File | What it settles |
|---|---|
| `spikes/A-jqformat.md` | Whether the write phase can reproduce `jq .` from JS. **Yes**, with a literal-preserving number parser. Feeds P-49 and P-50. |
| `spikes/B-jq-wasm.md` | Whether `repair journal --apply` can keep a real jq engine. **Yes** — embed `jq-wasm`. Feeds P-51, OQ-13 and OQ-14. |
| `spikes/C-tree-sitter.md` | Whether Python can leave the CLI. **Yes** — `web-tree-sitter` reproduced the index byte-identically. |
| `PROMISES-KEPT-AUDIT.md` | The orchestrator's line-level audit of the bash codebase against the manifesto. Signed with this file at the Phase 0 gate. |

---

# Group A — Exit codes and verdicts

## P-01 · Advisories never move the exit code

**What is loose.** `row_warn`, `row_tell` and `row_note` are recorded in
`checks[]` with `ok: true` and their tier, they print, and they are invisible
to the verdict. Only `row_fail` can make a run exit non-zero. A red linter is
a finding, not the command's failure.

**Where.** `.claude/scripts/lib/cli.sh:19-21` (the published API),
`:33-48` (the exit rule, stated as the contract), `:83` — the single line
where the tier decides `CLI_OK`:

```sh
case "$_r_tier" in fail) _r_ok=false; CLI_OK=0;; *) _r_ok=true;; esac
```

`_row` also ends `return 0` unconditionally (`:94`), so emitting a row can
never fail the calling function. Established by **D-0072 boundary 7** and
**T-0144**; restated in `CLI-CONSOLIDATION.md §4`.

**Port note.** The tier→verdict mapping lives in exactly one function. Do not
add a "strict mode", do not let a `warn` count toward `ok`, and do not give
`row_tell` an exit code of its own. The three advisory tiers exist precisely
so that a finding can be *said* without being *enforced* — that is the entire
mechanism by which boundary 7 keeps governance corrections off the agent's
path. Porting this stricter is a regression.

## P-02 · `status session` exits 0 for every DATA condition, without exception

**What is loose.** `scrumux status session` never lets the *state of the
records* move its exit code — not a missing `GOV_ROOT`, not a nonexistent
directory, not a corrupt journal, not every journal corrupt at once. A journal
it cannot read produces a **printed refusal inside the brief**, and the
command still exits 0.

**Measured, not assumed.** Probed against a scratch `GOV_ROOT` on 2026-08-31:

| Condition | rc |
|---|---|
| empty `GOV_ROOT` (no journals at all) | **0** |
| `GOV_ROOT=/nonexistent-probe-xyz` | **0** |
| `tasks.json` is `NOT JSON AT ALL` | **0** |
| all seven journals unparseable | **0** |
| `--json` over the corrupt set | **0** |
| `TMPDIR` unwritable | **0** |
| **`status session bogus`** (surplus argv) | **2** |
| **`jq` absent from `PATH`** | **1** |

**So the contract is much narrower than "always 0", and both exceptions
matter.**

- A malformed *invocation* refuses at exit **2** via `die_usage`
  (`lib/cmd-status.sh:359`).
- **A missing `jq` exits 1, not 2** — the surprising one. `lib.sh:77` guards on
  `jq` and calls `die`, but at that moment `die` is still *`lib.sh`'s*
  (`lib.sh:75`, `exit 1`); `lib/cli.sh:199` has not yet redefined it to exit 2,
  because `scrumux:58` sources `lib.sh` first. So the one command
  contractually forbidden to fail returns **1 — "the assertion did not hold" —
  for a command that never ran at all**, which is exactly the confusion the
  three-code rule exists to prevent (`lib/cli.sh:42-48`).

What *is* guaranteed, and measured: with the argv the SessionStart hook
actually passes — `scrumux status session`, zero arguments — no state of the
records or the filesystem produces a non-zero exit.

**Where.** `.claude/scripts/lib/cmd-status.sh:14-17` states the contract;
`:33-45` explains the mechanism (`refuse_journal` prints the refusal into the
brief rather than moving the exit code, because *"the jq parse errors on
stderr are not surfaced by the SessionStart hook"*). Asserted as a property of
the surface, not of one script, at `tests/cli-shape-tests.sh:227-236`:

```sh
for g in "$SANDBOX" /nonexistent-cli-shape-probe; do
  (cd "$ROOT" && GOV_ROOT="$g" "$S" status session >/dev/null 2>&1); [ $? -eq 0 ] \
    && ok || bad "status session must exit 0 even with GOV_ROOT=$g — it is injected into every session"
done
```

Note that the suite asserts exactly the two data conditions, not the argv one.

**Port note (revised twice).** State the guarantee as **"exit 0 for the
zero-argument invocation over any state of the records"** — not "always 0",
not "no data-driven path". Keep the argv refusal at 2. If an unexpected throw
inside the session brief would hit the generic error boundary in
`src/bin/scrumux.ts` and become exit 2, `status session` needs a carve-out
that prints the refusal into the brief and still exits 0; **do not extend that
carve-out to argv**, or the one thing catching a mistyped invocation goes
silent.

The jq-absent path disappears in the port — there is no jq — but its *shape*
does not: any bootstrap failure firing before the CLI exit rule is installed
inherits the wrong code. **Install the exit rule before anything that can
fail.**

*Corrected twice. First reading: "no path to a non-zero exit" — refuted by an
argv probe. Second: "no data-driven path" — refuted by an independent
validator, which found the jq guard exits 1. Both errors ran the same
direction: trusting a contract the code states about itself.*

## P-03 · A module that returns without calling `emit` still produces the envelope

**What is loose.** `cli_finish` is a dispatcher-level safety net: a noun
module that falls off the end without calling `emit` gets one anyway, with a
summary derived from its rows. The header calls this a safety net and "never
a licence".

**Where.** `.claude/scripts/lib/cli.sh:202-213`.

**Port note.** Keep the net. A TS port that makes "every code path must call
`emit`" a type-level requirement is stricter than bash and will turn a
missed branch into a crash where bash produced a valid object. Model it the
same way: dispatch calls the handler, then calls `finish()`, which is a no-op
if the envelope was already emitted.

## P-04 · A red `lint`-type health check is a TELL and never fails the run

**What is loose.** `run_health_checks` classifies a non-zero result by the
check's declared `type`: a `lint` check that exits non-zero is reported as
`TELL` and is **not** counted in `hc_fails`. Only a `test` check turns the
run red. `TIMEOUT` (rc 142) does count.

**Where.** `.claude/scripts/lib.sh:743-753`, with the reasoning inline
(T-0144): the three linters sweep the whole repo and their own headers call
their findings data (D-0011), so a style finding in a file the change never
touched must not block a commit.

**The branch ORDER is load-bearing too, and it hides a case.** `:750-753` is
tested in sequence — `rc == 0`, then `type == lint`, then `rc == 142` — so a
**`lint`-typed check that TIMES OUT is reported TELL and is not counted**. A
lint that hangs for its full timeout is indistinguishable from a lint that
found something. Surfaced by the Phase 0 validator; no comment addresses it,
and it is recorded here rather than changed (see OQ-15).

**Port note.** The `type` field is load-bearing and defaults to `test` in two
places — the jq projection `(.type // "test")` (`lib.sh:731`) and the
collation fallback `cat … || echo test` (`:742`). Do not "fix" the asymmetry
by making every non-zero a failure, do not drop either default, and **port the
branches in the same order**. Consumed downstream at `cmd-task.sh:1021-1026`,
where `TELL` gets its own arm and stays out of `CHECKS_FAILED`.

## P-05 · `task verify` passes with a STUB marker in place

**What is loose.** A `STUB(I-XXXX)`-marked boundary does not fail
`task verify`. The stub-and-park lane is the sanctioned response to a
blocker, and a verify that passes over a marked stub is the lane working.

**Where.** `.claude/scripts/lib/cmd-task.sh:903-904` states it as deliberate,
citing **D-0015 / T-0038**. `DESIGN_SPEC.MD §8` ("Stub and park") is the
ruling: *"A verify may pass with a marked stub in place — that is the lane
working, not a cheat."* `session check` section 6b tracks a *stale* marker as
a TELL, not a FAIL.

**Port note.** Do not add a stub scan to the verify path. The close is where
stub debt is observed, and it observes it as advice.

## P-06 · The T-0144 tell tier: eleven gates that were blocks and are now advice

**What is loose.** A named set of refusals were deliberately converted from
`block` to `tell`. They print their finding and their fix, write nothing to
the verdict, and the run continues at exit 0. Among them:

| Site | Now a TELL because |
|---|---|
| `task brief` — task in no ratified sprint | `session check` §1 is the backstop; refusing the brief hides the order from the person who would fix it |
| `task brief` — another task `in_progress` | reading an order is not starting work; the write still blocks |
| `task lint` — suite named without an interpreter | a portability wart, not a lie |
| `task lint` — `out_of_scope` empty | a judgement call about how much was excluded |
| `sprint new --epic` — decision queue not empty | withholding planning does not get the questions answered |
| `sprint descope` — task already has log entries | the advice is right and the block is not |
| `task reject` — another task `in_progress` | scheduling advice, not truth |
| `session check` §1 — worked outside a ratified sprint | the work is already done by the time this runs |
| `session check` §2 — multiple tasks `in_progress` | the write already blocked the second one |
| `session check` §6b — stale STUB marker | bookkeeping drift |
| `status` — reporting while a sprint has unfinished tasks | it is a read-only report |

**Where.** `governance/enforcement-posture.md`, "The table (snapshot,
2026-08-21)" — every row carries its own "why that tier". **D-0082** records
that four rulings (D-0004, D-0005, D-0015, D-0016) still *say* FAIL while the
code now warns, and explicitly upholds the demotions: *"The demotions
themselves stand — they were made deliberately, by accepted tasks, and this
does not reverse them."*

**Port note.** This is the single most likely place for silent tightening,
because the *rulings* read as blocks and the *code* is advice. **The code is
the spec.** When a decision entry and the bash behaviour disagree about a
tier, the bash behaviour wins for the port, and the disagreement is an Open
Question, not a licence to restore the gate. D-0082 exists precisely so this
is not rediscovered as a bug.

## P-07 · `records check` warns — never fails — on 145 acceptances with no recorded authority

**What is loose.** `--authority` became required on `task accept` on
2026-08-28. 145 historical acceptances carry none. `records check` reports
them as a **warning**, forever, and does not repair them in bulk. The same
treatment applies to `sprint ratify`, and `sprint.schema.json` deliberately
does **not** require the field.

**Where.** `.claude/scripts/lib/cmd-records.sh:550-580`:

> *"A WARNING, deliberately. Failing a clean repo 145 times every run is how
> a detector teaches the operator to ignore it… inventing an authority for an
> act nobody can now attest to would be worse than the gap."*

**Port note.** Do not add `authority` to the sprint schema's `required` list
and do not promote either warning. A backfilled authority is an invented
attestation — Article 4, exactly.

---

# Group B — Writes that never refuse

## P-08 · `walls_record` always returns 0; a failed event write never blocks

**What is loose.** `walls_record` appends one `wall` event to
`.scrumux/events.jsonl` and **returns 0 no matter what**. Every failure path
returns 0 early: no writable directory, no `jq`, an unwritable file. The
append itself ends `|| :`. Recording never changes whether a wall blocks —
only whether anyone can later count it.

**Where.** `.claude/hooks/walls-lib.sh:253-256` states the contract:

> *"Appends one `wall` event to .scrumux/events.jsonl and returns 0 no matter
> what. The caller then refuses exactly as it always did: recording never
> changes whether a wall blocks, only whether anyone can later count it."*

Body at `:277-320`; the early returns at `:279` and `:280`; the silenced
append at `:318` (`|| :`); the unconditional `return 0` at `:319`. The same
principle is restated at the call site in
`.claude/hooks/block-upstream-edit.sh:137-139`: *"a wall that fails because
its bookkeeping failed would be worse than the write it prevented."*

**Port note.** In TS this becomes a function that **cannot throw**. Wrap the
whole body in try/catch, return void, never propagate. The tempting stricter
version — "if we cannot record a refusal, refuse harder" or "let the error
propagate so we notice" — inverts the ruling and makes a bookkeeping failure
into a blocked tool call. Also preserve the two truncations (`%.200s` on the
subject, `%.400s` on the reason) and the `sessionId: null` / `subAgent: null`
behaviour: a wall fires from plain CLI runs with no agent present, and
inventing an id there was the defect the `null` fixes.

## P-09 · A failed `.backups` copy never refuses a governance write

**What is loose.** Before replacing a journal, `_write_json_body` copies the
current version into `governance/.backups/`. **Every step of that is
best-effort.** `mkdir -p` is `|| :`, writing the self-ignoring `.gitignore`
is `|| :`, the `cp -p` itself is `2>/dev/null || :`, and the pruning loop's
`rm -f` is `2>/dev/null || :`. A full disk, a read-only `governance/`, a
permissions problem — none of them turns a governance write into a refusal.

**Where.** `.claude/scripts/lib.sh:255-273`. The reason is stated at
`:267-269`:

> *"Failures are ignored on purpose -- a full disk must not turn a
> governance write into a refusal."*

**Port note.** Port the backup as a fully-swallowed side effect. The
temptation is strong here because the backup exists to prevent a *measured*
data loss (decisions.json, 80 entries → 6, 2026-08-27) — which makes it look
like something that should be guaranteed. It is not guaranteed and was never
meant to be: the guarantee is the entry-count guard (`ALLOW_ENTRY_REMOVAL`),
and the backup is the recovery aid beside it. Also preserve
`JOURNAL_BACKUPS=10` and the newest-first pruning: the comment at `:245-254`
records that "take the newest" is *not* always the right restore, which is
why ten generations exist.

## P-10 · The attestation write never blocks and never prints

**What is loose.** When `block-destructive` honours a `HARNESS_BACKUP_DONE=1`
attestation, it appends one row to `governance/attestations.jsonl`. The whole
block — the `mkdir -p` and the `jq` append — is wrapped in
`{ … } >/dev/null 2>&1`. A failed write leaves the hook silent at exit 0.

**Where.** `.claude/hooks/block-destructive.sh:306-322`, with the reason at
`:309-311`: *"Logging never blocks the command and never prints: a failed
write leaves the hook silent at exit 0, because a broken record must not
become a broken tool call."*

**Port note.** Same shape as P-08. Note also `:111-125`: **exactly one**
attested class per invocation, first matching branch wins, and the write
happens once at the end — an `rm -rf` that also drops a table produces one
row, not two. Do not "improve" this by recording every matched class.

## P-11 · The derived-value cache never fails anything

**What is loose.** `cache_put` returns 0 on every path — it drains stdin and
returns 0 if it cannot even create the directory. `cache_get` returns 1 for
absent, empty or unreadable, and every caller falls through to a full
computation. The whole `governance/.cache/` directory is disposable.

**Where.** `.claude/scripts/lib.sh:551-596`. The header states the
invariant: *"Entirely disposable. Removing the directory changes nothing but
timing… Side effects NEVER go behind it."*

**Port note.** Keep the "never fatal" contract and — more importantly — keep
the **no-side-effects-behind-the-cache** rule. The cache key is a live
`shasum` of the journal contents, deliberately **not** read out of
`seals.json`, so a journal edited outside `scrumux` still invalidates. Do not
optimise that into reading the seal.

## P-12 · `seal_bootstrap` records the risk instead of refusing it

**What is loose.** Deleting `seals.json` and making any write rebuilds the
whole seal map from whatever the journals contain *right now* — sealing in
any hand edit made before it, as though `scrumux` had written it. That is the
laundering the seal exists to catch, available to anyone who can `rm` a file.
**It still creates the file.** What it does instead of refusing is stamp
`bootstrapped_over_existing_content: <date>` into `seals.json`, and only when
some journal actually has entries.

**Where.** `.claude/scripts/lib/journal.sh:149-181`, comment at `:151-166`:

> *"It still creates the file, because a repo that predates sealing has to be
> able to start. What changed is that the fact is RECORDED rather than
> printed."*

**Port note.** Do not refuse a bootstrap over existing content, and do not
warn on stderr — the comment explains why a stderr warning was rejected (it
spliced into a refusal message and is gone by the time anyone investigates).
Write the flag; `records check` reads it.

## P-13 · `reseal_one` deliberately never calls `seal_journals`

**What is loose.** A journal write reseals **only the file it wrote**. It
would be simpler to call `seal_journals` and rebuild the whole map. That was
the original behaviour and it silently defeated the mechanism: rewriting
every hash meant any unrelated `scrumux` command re-sealed a hand edit and
erased the evidence.

**Where.** `.claude/scripts/lib.sh:275-284` (the call site's reason) and
`:312-357` (`reseal_one`). `journal.sh:154-160` records the measurement: *"a
tampered tasks.json was reported by governance-validate, then one
`scrumux decide` made the report disappear."*

**Port note.** This looks like duplicated logic asking to be collapsed. It is
the opposite: `seal_journals` runs exactly once, to create the file;
`reseal_one` runs on every write. Collapsing them destroys tamper detection.
Keep the lock order too — **journal then seals, never the reverse**
(`lib.sh:322-325`) — because `seals.json` is touched by every journal write
and is the most contended object in the system.

**Note on a related tightening that *was* made deliberately — and lands only
halfway.** `reseal_one` used to return 0 on its own write failure, which
silently broke the seal and made the *next* `records check` report a false
accusation of tampering. It now prints a named message and returns 1
(`lib.sh:347-355`), and the journal write has already landed and is **not**
rolled back. Port that shape exactly: report, do not refuse, do not unwind.

**But the `return 1` reaches no caller.** `reseal_one` is the last statement
of `_write_json_body` (`lib.sh:284`), so the body's status is its status — and
`write_json` (`:291-295`) then ends with `journal_unlock`, which is
`rmdir … || :` (`:170`) and always returns 0. The failure status is swallowed
one frame up. Only the stderr line at `:353` survives, and **under `--json`
stdout carries the one object while that line goes nowhere structured** — a
machine consumer cannot see that the seal broke. Surfaced by the Phase 0
validator. Recorded, not fixed: see OQ-18.

## P-14 · A graph build failure is non-fatal on the write path and fatal for `views render`

**What is loose.** `render_views` rebuilds the governance graph and treats a
failure as non-fatal: it sets `GRAPH_BUILD_FAILED=1`, prints a warning to
stderr, and the surrounding write completes. The *same* failure, reached
through `scrumux views render`, produces a `row_fail` and a non-zero exit.

**Where.** `.claude/scripts/lib/journal.sh:100-123` (the write path;
T-0129: *"kept non-fatal on the WRITE path on purpose — a graph failure must
not abort a journal write mid-transaction — but no longer silent"*) and
`.claude/scripts/lib/cmd-views.sh:24-34` (the explicit-request path).

**Port note.** Two call sites, two dispositions, one condition. Do not unify
them behind a single "throw on graph failure". The asymmetry is the design:
an implicit rebuild must not abort a transaction; an explicit request must
not report success it did not achieve.

## P-15 · `task verify`'s receipt write can fail without changing the verdict

**What is loose.** `task verify` computes its verdict from the command's exit
code and the check counts, then writes the receipt. If `governance/` is not
writable (a read-only agent sandbox), it prints a line to stderr saying so
and **the verdict above stands** — the command still exits with the verdict
it measured.

**Where.** `.claude/scripts/lib/cmd-task.sh:953-971`, with the contract
stated inline: *"The receipt is EVIDENCE, never a verdict: a failure here
says so on stderr and does not change the exit code."*

**Port note.** Do not couple the verdict to the receipt write. `task accept`
is where a missing receipt bites, and it refuses there with a message naming
the fix.

---

# Group C — Reads: absence is normal, unreadable is not

## P-16 · `read_journal` is tri-state, and absent is normal

**What is loose.** Three outcomes, and collapsing any two of them is a
defect that has already been shipped four separate times:

| State | Behaviour |
|---|---|
| **absent** | print the default (`{"entries":[]}`), **return 0** |
| **present and parses** | print the file, return 0 |
| **present and does not parse** | print **nothing**, return non-zero |

It never calls `die`, because — the header says — two callers dispose of the
same fact differently.

**The header is wrong about its own callers, and the port must not copy it.**
Verified: `read_journal` has exactly **three** live call sites, all in one
file (`lib/cmd-status.sh:52`, `:72`, `:90`), and all three honour the
tri-state. **`cmd-backlog.sh` never calls it.** It hand-rolls the same check
three times as `jq -e . … || die "…"` (`cmd-backlog.sh:36-37`, `:86-87`,
`:95-96`), and under the CLI that `die` is `lib/cli.sh:199` → **exit 2**, not
the exit 1 the header promises. Measured:

```
$ GOV_ROOT=<scratch> .claude/scripts/scrumux backlog tasks
scrumux backlog tasks: error: governance/tasks.json is not valid JSON — restore it from git, …
rc=2
```

So no caller *collapses* the tri-state — the contract holds — but the
documented second consumer bypasses the function and the comment's exit code
is stale. See OQ-16.

**Where.** `.claude/scripts/lib.sh:101-129`. The header enumerates the four
sites that got it wrong the same way — I-0078, I-0083, T-0156, I-0102 —
because *"each read is a bare `jq ... "$f"` … and a jq parse error there
leaks to stderr and hands the caller an EMPTY string."*

**Port note.** In TS the tempting shape is `readJournal(path): Journal` that
throws on both absent and malformed. **That is a two-state collapse of a
three-state contract.** Model it as a discriminated union
(`{kind:'absent'|'ok'|'unreadable'}`) and let each caller decide. Do not make
absence an error: a fresh repo is a normal state, and `ensure_file` exists so
absence is repaired at the *write* path, not the read path.

**And port `cmd-backlog.sh`'s exit code as it actually is (2), not as the
comment says (1).** Routing backlog through the shared reader would be tidier
and would silently change a verb's exit code — a differential failure with a
documentation comment as its only justification.

## P-17 · A sealed journal that is gone is skipped, not reported

**What is loose.** `broken_seals` skips any journal named in `seals.json`
that no longer exists on disk. It reports only files whose *content* does not
match their recorded hash. It is also silent when `seals.json` itself is
absent, so a repo that has never been sealed is not reported as tampered.

**Where.** `.claude/scripts/lib.sh:399-409` (the reason) and `:538-546`
(the `[ -f "$GOV/$_name" ] || continue`). The reason is a measured parsing
bug: callers word-split the output, so the old `"<name> (recorded but
missing)"` line was read as four journals named `(recorded`, `but`,
`missing)` and the name itself — every removed journal produced four nonsense
failures. And: *"A journal removed on purpose is a seals.json entry to drop,
which is bookkeeping, and bookkeeping is not a tamper report."*

**Port note.** TS has no word-splitting problem, which makes it *easier* to
"fix" this into a report. Do not. The ruling is about what a tamper report
means, not about shell quoting.

## P-18 · `seals_shape_problem` reports and always returns 0

**What is loose.** Three conditions make the seal file useless — it does not
parse, `.journals` is not an object, or it records zero journals. Each
produces a sentence on stdout naming the consequence ("so nothing is being
checked"), and the function returns 0 in every case, including when it found
nothing.

**Where.** `.claude/scripts/lib.sh:410-420` and `:520-536`. The reasoning is
at `:412-417`: *"THE SEAL SILENTLY CHECKING NOTHING IS WORSE THAN NO SEAL"* —
and the fix was to make the *absence of checking* speak, not to refuse.

**Port note.** A caller distinguishes "found a problem" from "no problem" by
whether the returned string is empty, never by the exit code. Port the same
signature.

## P-19 · `run_health_checks` returns 0 when there is no registry

**What is loose.** No `governance/repo-health.json` → `return 0`, having run
nothing and asserted nothing.

**Where.** `.claude/scripts/lib.sh:690-691`.

**Port note.** A repo with no registered checks is not a failing repo. This
matters for a fresh deploy, which seeds **zero** health checks by design
(P-32).

## P-20 · A graph reader never rebuilds and never refuses on staleness

**What is loose.** Every graph query answers from the on-disk index and
**stamps the answer with its provenance** rather than withholding it. The
freshness check `graph code index` has four outcomes and only one fails:

| State | Verdict |
|---|---|
| current | pass |
| stale, builder present | rebuild, pass |
| stale, **no builder** | **TELL, and still pass** |
| no index and no builder | fail |

**Where.** `.claude/scripts/lib/cmd-graph.sh:344-348` (the TELL) and `:32`,
`:288`, `:305`. Design record: `CLI-CONSOLIDATION.md §8b`. Ruling: **D-0044**
(superseding D-0043) — *"a check's name must state what it asserts"*, and a
derived artifact's check asserts that the artifact **can be built**, failing
only on a real defect.

**Port note.** The old `refresh_if_stale` ran a full parse on every query,
which is exactly what made a reader need a toolchain. Do not restore it, and
do not turn the no-builder TELL into a FAIL — *"a repo cannot act on a
toolchain it was never meant to carry."*

---

# Group D — Walls: what they deliberately do not catch

## P-21 · `authority_guard` deliberately does not verify WHO is calling

**What is loose.** `authority_guard` validates the *shape* of an authority
string — `direct`, `app`, `app:<session>`, or `standing:D-NNNN` whose ref
must resolve — and nothing more. It does not check that the caller is who
they say they are. Nothing in the CLI does.

**Where.** `.claude/scripts/lib.sh:437-439`, verbatim:

> *"NOTE WHAT THIS DOES NOT DO: it does not check WHO is calling. Nothing in
> this CLI does, and pretending otherwise would be the same lie as the old
> `--by User` default. It records the basis; it does not verify the actor."*

Function at `:440-457`. This is **Article 4** at its sharpest: the check
claims only what it computes. It also connects to **D-0069** — an acceptance
must *record* the authority it acted under so a standing-authorisation
acceptance is distinguishable in the record from one User read himself.

**Port note.** Do not add identity verification, a caller allowlist, an
actor↔authority cross-check, or a "User-only" assertion on `direct`. The
separation that matters is **producer from verifier**, and the ruling
(Manifesto Article 10) is precise: *"the verifier need not be a person, but
it must hold a distinct issued identity."* That is enforced where it is
enforceable — `issue validate` refuses disjointness only (P-27) — not here.

## P-22 · Seals deliberately exclude derived journals

**What is loose.** `SEALED_JOURNALS` is an explicit eight-name list, not a
glob over `governance/*.json`. `code-graph.json` and `governance-graph.json`
are **derived** and are deliberately absent, as is `seals.json` itself and
everything under `governance/.cache/`.

**Where.** `.claude/scripts/lib.sh:368-374`:

```sh
SEALED_JOURNALS="design.json tasks.json sprints.json decisions.json issues.json exceptions.json log.json repo-health.json"
```

Reason at `:369-373`: *"globbing sealed them and they broke on every rebuild.
A glob would also silently adopt any future derived file."* The measured
consequence of getting it wrong is recorded at `:327-339`: scrumux-agents'
`seals.json` carried both graph indexes, so `harness deploy` reported its own
clean install as FAILED, every time, with no way to clear it.

**Port note.** Keep the literal list. A TS port will want
`readdirSync(gov).filter(f => f.endsWith('.json'))` — that is the exact
regression. The pruning half of `reseal_one` (`lib.sh:340-343`) exists to
*remove* keys the current list excludes; keep it.

## P-23 · `block-upstream-edit` deliberately ignores `project-walls.conf`

**What is loose.** Three of the four walls consult `.claude/project-walls.conf`
first and honour an `allow` line. The fourth does not — it never calls
`walls_allows` or `walls_refuses`, and sources `walls-lib.sh` only for
`walls_record`.

**Where.** `.claude/hooks/block-upstream-edit.sh:51-60`, verbatim:

> *"Its two siblings check it first; this wall deliberately does not, and
> that asymmetry is the design. project-walls.conf lives INSIDE the deployed
> repo and an agent may write it. Every other wall protects the repo from the
> agent, so the repo's own say is the right override. This one protects the
> UPSTREAM from the repo — an allow line here would let any agent exempt
> itself from D-0078 boundary 1 by writing one file, and the wall would be
> advisory. The lever for this wall is upstream, on purpose. 'There is no
> repo-level fix available to me' is the correct answer to a genuine block,
> not a defect."*

Sourcing note at `:100-105`. Ruling: **D-0078**.

**Port note.** This is the one asymmetry a porter will "unify". Four walls,
one shared conf helper, three call sites — it reads like a missed fourth.
It is not. Write a comment at the TS call site saying so, because the next
reader will have the same reflex.

## P-24 · The `.example` / `.template` / `.sample` exemption is a deliberate false negative

**What is loose.** A read target ending `.example`, `.template` or `.sample`
is exempt from the secret wall. `cat .env.example` passes. The header states
it as design: *"they hold shapes, not secrets."*

The two arms read the exemption **differently**, and that difference is also
deliberate:

- **Read arm** (`$FP` is one resolved path): a whole-target exemption is
  correct.
- **Bash arm** (`$CMD` is a whole command line): each read **operand** is
  judged on its own. `cp .env.example .env && cat .env` still blocks on the
  `cat`, because only the operand that itself ends in an exempt suffix is
  exempt.

**Where.** `.claude/hooks/block-secret-reads.sh:6-7` (the design statement),
`:37-45` (the two-arm split, CLI-2), `:79-81` (Read arm), `:130-150` (Bash
arm, per-operand loop), `:143-145` (the exempt suffix test).

**Port note.** Port both arms *separately*. Unifying them onto one predicate
either re-opens the CLI-2 hole (whole-line exemption) or breaks the benign
`cat .env.example` case. Also preserve `tr -s '[:space:]' '\n'` word
splitting rather than a shell `for` loop — the comment at `:132-134` records
that `for w in $CMD` glob-expands a `*` in the command against the cwd.

## P-25 · Bare `cat credentials` passes the Bash arm

**What is loose.** A file named exactly `credentials`, with no directory
component and no extension, is not matched by the Bash arm. Reading it
through the Read tool still blocks.

**Where.** `.claude/hooks/block-secret-reads.sh:47-51`, verbatim:

> *"Known limit, and a deliberate one… A wall that refuses the word
> 'credentials' in prose costs a session every time an order mentions it and
> prevents nothing, which is the trade this repo declines."*

The mechanism is the `AMBIG_CMD` vs `AMBIG_PATH` split at `:62-64`: words
that are also ordinary English require **path context** — a slash, a `~`, or
an extension — in the command arm, and match bare in the resolved-path arm.
Established by **I-0135**.

**Port note.** Do not merge `AMBIG_PATH` and `AMBIG_CMD`. The tempting
stricter version blocks `scrumux task new --check "no credentials appear
anywhere"`, which is a measured false positive this repo has already paid
for. Port the two regexes as two regexes.

## P-26 · Command substitution and data-driven paths are an accepted inherent limit

**What is loose.** No wall can see through `$(...)`, or through a path that
arrives as data (`xargs cat < list`, a filename in a variable, a `cd` plus a
relative name). This is documented and explicitly **not chased**.

**Where.** `TS-MIGRATION-HANDOFF.md §5`: *"KNOWN INHERENT LIMIT (all walls,
un-fixable by static string inspection): command substitution `$(...)` and
data-driven paths (`xargs cat < list`). Document it; do not chase it."*
`block-upstream-edit.sh:62-74` states the same limit for its own Bash arm and
names the two deliberate calls it makes at the edges. `DESIGN_SPEC.MD §4b`
gives the governing principle: *"A check bottoms out at a cooperative
author… Close the weakest careless artifact, note a deliberate hole if it is
interesting, do not chase it."*

**Port note.** A TS port has a real tokenizer available and will be tempted
to chase this. Do not. The walls are act-gates against *careless* acts; the
answer past that line is a second party reading the work, not a deeper
parser. Any TS wall that starts resolving variables has changed the mechanism
class without a ruling.

## P-27 · Two more deliberate "look at MORE, never less" limits in `walls_cmd_words`

**What is loose.**

1. **Heredoc bodies are yielded as if they were commands.** Every line of a
   heredoc body produces command words. That over-reports, and the header
   says so explicitly: *"That is the safe direction — it can only make a wall
   look at MORE, never less."*
2. **Non-mutating wrapper step-over.** `env sudo time nohup exec command` and
   `nice ionice timeout xargs stdbuf setsid flock chrt doas` are stepped
   over, along with the prefixer's own flag group, so the real program
   surfaces. This *strengthens* every wall and can never weaken one.

**Where.** `.claude/hooks/walls-lib.sh:139-143` (the heredoc limit) and
`:127-138` + `:174-179` (the wrapper set and the flag-group skip). The
flag-skip heuristic is stated as safe because *"No real program word is a
bare number"* (`:177-178`).

**Port note.** When porting `walls_cmd_words` to a character state machine
(the plan's biggest named risk), preserve the over-reporting. A "more
accurate" tokenizer that stops yielding heredoc bodies **weakens** the wall
and re-opens I-0121. The awk is frozen as a permanent oracle for exactly this
reason.

## P-28 · One invalid `project-walls.conf` pattern is skipped and named; the rest still apply

**What is loose.** `walls_field` compiles each conf pattern individually
against empty input before merging. A pattern that will not compile (grep
exit 2) is **skipped and named on stderr**, and the remaining patterns are
still applied. One typo does not disable a repo's whole wall extension.

**Where.** `.claude/hooks/walls-lib.sh:40-67`. The measured failure it
closes: *"a conf with a legal `(foo|bar)\.env` rule disabled its `id_rsa`
rule too."* Reason splitting is at the **last** pipe, not the first
(`:28-35`), so a pattern may legally contain a `|`.

**Note on the asymmetry beside it, which is deliberate in the other
direction.** `walls_allows` fails **closed** by returning 1 on anything but a
match (`:70-74`); `walls_refuses` fails **closed** by returning 0 — refuse —
when grep exits > 1 (`:84-94`). Two different codes, one direction: when in
doubt, refuse. Worth stating because the natural TS port of "this regex did
not compile" is to throw, and the bash contract is **asymmetric per verb**.

**And what "valid" means here is thinner than it looks.** The reason filter is
`grep -F '|'` (`:53`) — the presence of a pipe, not of text after it — and
`:56` skips only a line whose *pattern* is empty. So a rule with an **empty
reason is accepted and silently active**, unlike an uncompilable pattern,
which is named on stderr at `:61`. That is the mechanism behind OQ-4.

**Port note.** The ERE→JS translation layer must reproduce **both** halves:
per-pattern validation with a named skip, and fail-closed on a compile
failure at the refuse site. A TS port that compiles the merged alternation
once has re-created the exact bug this closes. And a pattern that JS accepts
but POSIX ERE rejects (or vice versa) must be treated as a *port* question,
not silently normalised — see Open Question OQ-8.

## P-29 · `allow` wins, including over a built-in wall

**What is loose.** In three of the four walls, `walls_allows` is consulted
**before** every built-in pattern and exits 0 on a match. A repo can exempt
itself from the destructive, secret-read and direct-LLM walls with one conf
line carrying a reason.

**Where.** `.claude/hooks/block-destructive.sh:100-104`,
`.claude/hooks/block-secret-reads.sh:83-85` and `:113-114`,
`.claude/hooks/block-direct-llm.sh:28-29`. The stated reason is identical at
each: *"A wall that argues with its owner is the wall people route around."*
Ordering rule at `walls-lib.sh:22-24`. Design requirement:
`DESIGN_SPEC.MD §6`, *"The refused set is extensible per project"*.

**Port note.** Keep the ordering (allow, then repo `refuse`, then built-ins)
and keep the reason requirement — a line with no `|` reason is ignored
(`walls_field`'s `grep -F '|'`). Do not add an "allow cannot override a
built-in" rule; that is the fork-the-hook failure this exists to prevent.

## P-30 · `HARNESS_BACKUP_DONE=1` is an attestation, not a verification

**What is loose.** The destructive wall accepts `HARNESS_BACKUP_DONE=1` as an
env-assignment prefix in command position and lets the act proceed. It does
not check that a backup exists.

**Where.** `.claude/hooks/block-destructive.sh:12-16`:

> *"Backup acknowledgment: prefixing the command with HARNESS_BACKUP_DONE=1
> attests a backup exists. The attestation is NOT taken on trust and is NOT
> left to the agent to remember (T-0131): every honoured attestation appends
> exactly ONE line to governance/attestations.jsonl."*

The recognition is deliberately narrow (`:127-135`): **only** at the start or
immediately after a `;`/`&&`/`||`/`|` separator, judged on `$cmd_nc` so a
trailing comment can neither supply the attestation nor fake one (CLI-3).

**Port note.** "NOT taken on trust" means *recorded*, not *verified*. The
wall computes what it can (the syntactic position, the comment strip) and
records the rest. Adding a check that a backup actually exists would be a
check the harness cannot compute — Article 4. Port the position regex
exactly.

## P-31 · `attestations.jsonl` records the full command on purpose; the event stream never does

**What is loose.** Two sinks, two policies, and the asymmetry is deliberate:

- `.scrumux/events.jsonl` receives a **safe subject** only — a path or a
  program word, never a raw command line, because a command line can carry a
  secret in a flag.
- `governance/attestations.jsonl` receives the **full `$cmd`**, because it is
  a deliberate audit sink for an act a person attested to.

**Where.** `.claude/hooks/block-destructive.sh:137-141` (the block()
contract, CLI-5) and `:315-320` (the attestation write, `--arg command
"$cmd"`). `walls-lib.sh:269-271`: *"THE SUBJECT MUST ALREADY BE SAFE…
Truncated as a second line of defence."* The `.jsonl` extension is itself
load-bearing (`block-destructive.sh:17-19`): `records check` globs
`governance/*.json` and jq-parses every match, so a line-delimited file must
stay outside that glob.

**Port note.** Do not unify the two sinks and do not sanitise the attestation
row. Keep the `.jsonl` extension and keep the truncations on the event row.

## P-32 · The destructive wall's scope is narrower than "destructive"

**What is loose.** Three classes only, and each has a stated boundary:

- **Recursive-force delete** — the regex requires **both** `r` and `f`
  (in either order, bundled or separate). `rm -r` alone, `rm -f` alone, and
  `rm` with no flags are not this class.
- **Database purge** — `drop database|table|schema|collection`,
  `truncate table` (the word `table` is now **required**, so coreutils
  `truncate -s 0 file` no longer matches), `flushall`, `flushdb`,
  `db.dropDatabase` — and **only** when a real DB client is a command word.
- **Git history destruction** — bare force-push, `reset --hard`, `clean -f`.
  `--force-with-lease` exempts, as a standalone word.

Deploy, production, TestFlight and tunnel actions are **not** hook-enforced.

**Where.** `.claude/hooks/block-destructive.sh:7-10` (*"Deploy/prod actions
are NOT blocked here — User's explicit v1 selection"*), `:252` (the rm
regex), `:277-281` (the DB classes), `:289-304` (git). Restated in
`PROJECT_SPEC.MD` under Hooks: *"The deploy/production/TestFlight/tunnel hard
limit remains documented policy in CLAUDE.MD; it is **not** hook-enforced in
v1 (deliberate — User's selection)."*

**Two gaps beyond the stated scope, measured not inferred.** The Phase 0
validator drove crafted PreToolUse payloads through the real hook against a
scratch `GOV_ROOT`:

```
rm -r  <path>                          rc=0   (as designed — needs both flags)
rm -f  <path>                          rc=0   (as designed)
rm -rf / -fr / -r -f / -f -r  <path>   rc=2   BLOCKED
rm --recursive --force <path>          rc=0   <-- GNU long flags are not covered
rm -rd <path>                          rc=0   <-- -d is not r+f, though it deletes
find . -type d -delete                 rc=0   (outside the declared v1 scope)
```

`rm --recursive --force` performs exactly the act the wall names and passes.
The regex at `:252` is short-flag-only. **This is recorded, not fixed** —
widening it is a wall change and belongs to a ruling, not to a port. See
OQ-17.

**Port note.** Do not widen the rm regex, do not drop the `table` requirement
on `truncate`, and do not add a deploy class. `--no-preserve-root` is the one
sub-case blocked **unconditionally**, before any exemption (`:253-260`) —
preserve that ordering.

## P-33 · `permissions.deny` stays empty by ruling

**What is loose.** The shipped `.claude/settings.json` declares no `deny` and
no `ask` rules at all — only `permissions.allow`. Blocking is done by hooks.

**Where.** `.claude/settings.json` (`deny` and `ask` are absent; `allow` has
15 entries). Ruling: `DESIGN_SPEC.MD §15d`:

> *"`permissions.deny` stays empty. A deny rule refuses without a reason,
> without naming the standard, and without an alternative — which is the
> failure mode this run paid for six times over. §6 requires a wall to say no
> **and say why**; only a hook can."*

**Port note.** The port must not migrate any wall into a `deny` rule "because
it is cheaper than a hook process". Article 5 — the error message is the
instruction set — is the reason the hook exists at all.

---

# Group E — Schema validation is a deliberate subset

## P-34 · `schema_check` REPORTS unsupported keywords instead of failing on them

**What is loose.** The validator understands exactly seven keywords —
`type`, `properties`, `required`, `additionalProperties`, `enum`, `items`
(plus the inert `description`, `$schema`, `title`). Anything else in a schema
is not an error. A dedicated function, `unsupported_keywords()`, exists to
**name** them rather than fail on them.

**Where.** `agents/lib/schema_check.py:35-38` (`_KNOWN`) and `:49-62`
(`unsupported_keywords`). The module docstring at `:12-20` states the design:

> *"This is the reader. It is a deliberately small subset of JSON Schema…
> because that is exactly what these ten files use. A full implementation
> would be a dependency; this is ~80 lines of stdlib and adds none. If a
> schema ever needs more than this handles, the honest move is to say so
> loudly rather than silently ignore the keyword."*

Two further deliberate narrownesses in the same file:

- `additionalProperties` is enforced **only** when it is literally `False`
  (`:92`). Any other value is ignored.
- Union types (`["string","null"]`) are supported for the
  optional-by-null shape, and a `bool` where a `number` is wanted is
  rejected explicitly because Python's `bool` is an `int` (`:70-78`).

**Port note.** The migration plan already rules this: **`src/schema/check.ts`
is a hand-rolled subset port — NOT ajv.** Reaching for ajv adds a dependency
*and* silently enforces every keyword the schemas happen to contain, which is
tightening by library choice. Port the seven keywords, port
`unsupported_keywords()` including the fact that nothing calls it (see
OQ-2), and port the `bool`-is-not-a-`number` special case.

## P-35 · `check_journal` returns `[]` for a journal that is not there

**What is loose.** `check_journal` returns an empty violation list — not an
error — when the journal file does not exist. Absence is not a finding.

**Where.** `agents/lib/schema_check.py:121-122`.

**Port note.** Same principle as P-16. A fresh repo has no journals.

---

# Group F — Deploy, drift, and prose

## P-36 · `harness deploy` never merges an existing `settings.json` — with one narrow, named exception

**What is loose.** Where a target already has `.claude/settings.json`, deploy
leaves it **byte-for-byte alone**, names which hook chains are absent, and
prints the fix. It does not deep-merge, does not rewrite hooks, and does not
touch `env`.

**The one exception, and it is explicitly scoped:** `permissions.allow` is
**unioned** — append-if-absent, existing rules first, never removed. Nothing
else in the target changes.

**Where.** `.claude/scripts/lib/cmd-harness.sh:34-37` (the header's "WHAT
deploy DOES NOT DO"), `:506-539` (the implementation), `:860-885` (the
`settings-hook-commands` verify check). The exception's reasoning is at
`:515-523`:

> *"ONE narrow exception to 'never merged', and only this one (I-0155):
> `permissions.allow` is UNIONED… Without it a repo deployed before the allow
> list existed keeps refusing every headless governance call forever — the
> $0.62-per-dispatch failure T-0025 measured. Hooks, env and everything else
> in the target stay byte-for-byte alone: an allow rule is canon payload…
> not a user setting."*

`CLI-CONSOLIDATION.md §11c` records the consequence and the ruling on it:
deploy can orphan a hook command it just pruned, so a check was added that
**names the missing file and the exact remedy** — *"Reported, never
rewritten. Overwriting a repo's own settings file is an operator's call, not
an installer's."*

**Port note.** Two things to preserve exactly: the refusal to merge, and the
single union. A TS port with a JSON deep-merge library available will merge
"helpfully". It must not. And `settings-hook-commands` reports; it never
repairs.

## P-37 · `harness verify` splits drift into FROZEN and TRACKED, and TRACKED is never fatal

**What is loose.** Drift against `.claude/DEPLOYED` has two classes:

- **FROZEN** — `.claude/scripts`, `.claude/hooks`, `.claude/schemas`,
  `agents/lib/*.py`. A mismatch **fails**.
- **TRACKED** — `.claude/rules`, `.claude/skills`. Prose, where a repo
  legitimately localises. **Reported and never fatal.**

A repo with **no** `.claude/DEPLOYED` at all passes with a `true` check whose
detail says drift *cannot be computed and is not being claimed either way*.

**Where.** `.claude/scripts/lib/cmd-harness.sh:1112-1127`. Ruling: **D-0078**
(*"Prose that ships with the harness (.claude/rules, .claude/skills) is
tracked for drift and never blocked, per boundary 7"*).

**The half this entry first missed: a rules/skills file that is MISSING does
fail.** `:1136-1139` sorts any manifest file absent from disk into
`DRIFT_GONE` *before* the FROZEN/TRACKED `case` runs, and `:1183` fails on a
non-empty `DRIFT_GONE`. The code says so deliberately at `:1123-1124`: *"A
file the manifest lists and the disk does not have is frozen-class regardless
of which half it came from: the machinery is incomplete."*

So the rule is **"rules and skills never fail for CONTENT"** — not "rules and
skills never fail". A port built to the shorter sentence would wave through a
deployment missing half its rules.

**Port note.** Note the third state carefully: **"cannot be computed" is
reported as a pass, not a fail.** That is Article 4 again — a check may claim
only what it computes, and it must not report a verdict it has no basis for.
Keep the ordering: absent-from-disk is tested before the class split.

## P-38 · `harness deploy` seeds zero repo-health checks

**What is loose.** A fresh deploy registers no health checks at all. A repo
registers its own with `scrumux health add`.

**Where.** `.claude/scripts/lib/cmd-harness.sh:38-44`:

> *"It seeds ZERO repo-health checks. `records check` is User-inspection
> surface (boundary 7) and seeding it put its WARNs in the agent's path;
> acceptance run 1 shows the agent having to decide to ignore four of them."*

Also `DESIGN_SPEC.MD §12` (F8, resolved).

**Port note.** Do not seed a "sensible default" set. An empty registry is the
designed state and `run_health_checks` returns 0 over it (P-19).

## P-39 · `project-standards.md` ships empty, is never overwritten, and nothing enforces it

**What is loose.** Deploy creates `.claude/rules/project-standards.md` if
absent, with frontmatter and no content, and a redeploy never overwrites it.
No check reads its body. It is a place for a repo's requirements, and the
harness does not police what goes in it.

**Where.** `.claude/scripts/lib/cmd-harness.sh:565`, `:630-663`, `:798-809`.
README: *"an empty file for that repo's own requirements which nothing
enforces and no redeploy overwrites."* Ruling context: `DESIGN_SPEC.MD §12` —
the three hardcoded code standards were removed because *"That was one
person's stack compiled into a harness whose stated contract is that it
governs any repo in any language. A Go repo failed on principle."*

**Port note.** Do not add a linter for this file's contents. Phase 7 gives it
a *writing* surface (`scrumux rule …`); that is not an enforcement surface.

## P-40 · `paths:` in rule frontmatter is declarative; every rule loads regardless

**What is loose.** Rules declare `paths:` in frontmatter. The CLI loads every
`.claude/rules/*.md` unconditionally and ignores the declaration.

**Where.** `CLAUDE.MD`, final section: *"`paths:` in a rule's frontmatter is
declarative today: the CLI loads every rule regardless (D-0008, I-0001). That
is deliberate and not a defect — scoping is per-codebase and inert scoping
costs nothing."* Ruling: **D-0008**, restated in `DESIGN_SPEC.MD §15b`
(*"Path-scoped rules stay inert… I-0001 is not a defect to chase"*).

**Port note.** Do not implement path scoping. Do not fail a rule whose
`paths:` does not match anything. An inert declaration is the ruled state.

## P-41 · `parallel-work-isolation` is a rule with no check behind it

**What is loose.** The worktree rule is shipped as guidance and **no check
fails on it**, by explicit ruling.

**Where.** `PROJECT_SPEC.MD`, rules roster item 6: *"Deliberately unenforced:
no check fails on it… User's call is to ship it as guidance and strengthen
it only if the record shows it being ignored."* Restated in
`DESIGN_SPEC.MD §15b` under BUILT.

**Port note.** Article 2 in one line: a rule followed most of the time is
doing its job. Do not mechanise it.

## P-42 · `enforcement-posture.md` is read by no program, and a stale row is not a finding

**What is loose.** The refusal-site census used to be cross-checked against
the code in both directions by `validate` section 11. T-0184 deleted that
sweep and the file's frontmatter with it. Nothing reads it mechanically now;
its rows may have drifted from the code and that drift is **stale reference
data, not a finding**.

**Where.** `governance/enforcement-posture.md:1-11`, verbatim: *"Status:
historical reference. Nothing reads this file mechanically… No anchor is
checked, no row is enforced, and a row that has drifted from the code is
stale reference data — not a finding."* Ruling: **D-0074** step 1;
**D-0072 boundary 7**.

**Port note.** Do not rebuild the sweep. Read the file as history — it is the
best per-site reasoning in the tree — and treat any disagreement between it
and the code as *the code being right*. Confirmed while writing this
register: several rows name `.claude/scripts/validate` and
`.claude/hooks/monitor-compliance.sh`, both since deleted.

**Settled 2026-09-01, and it leaves the port a rule rather than removing
one.** The upstream copy moved to `docs/history/enforcement-posture.md` and
stopped shipping: `MACHINERY_DOCS` in `cmd-harness.sh` is now empty, a fresh
target receives no census, and `harness verify` does not demand one. This
entry and P-43 cite the old path because they are pinned to a commit where
that was the path.

**Existing targets keep their copy, and the prune must never take it.** The
file was target-editable on purpose — its shipping comment invited a target
to edit it, so an installed copy is that repo's own governance record by the
time we retire ours. It is declared prune-exempt through the same `seeded()`
list the create-if-absent lane uses ("RETIRED, NOT RECLAIMED" in
`cmd-harness.sh`). The general rule the port carries: **stop-shipping and
reclaiming are two decisions, not one.** Machinery is reclaimed because a
stale script still runs and the target never wrote it; a target-editable
document is left alone because deleting it destroys what upstream never
wrote and cannot reconstruct.

## P-43 · `governance/gates.json` is deliberately unranked, and pass/waive left the vocabulary

**What is loose.** The gate journal records a row only when a gate **refuses
or tells**, never when it considers and allows. There is therefore no
denominator and no ranking is possible. `pass` and `waive` were removed from
the enum on purpose.

**Where.** `governance/enforcement-posture.md:22-28`. Ruling: **D-0071**,
which explicitly upholds session-check's comment that *"a gate that
considered and allowed is not news"* as the settled contract, and records the
consequence: *"cost is measured per FIRING, never per decision, and a gate
that considered and allowed stays unmeasured."*

**Port note.** Do not emit an allow-path row "for completeness". D-0071
measured what that would cost: a journal write plus a views regeneration on
the PreToolUse hot path of every Bash call, across three hooks.

---

# Group G — Records the harness deliberately does not police

## P-44 · `rank` is never manufactured

**What is loose.** `scrumux task new` leaves `rank` unset. A rank exists only
where someone deliberately placed the task with `scrumux rank set`. The
backlog lists unranked work under its own heading, unnumbered.

**Where.** `.claude/scripts/lib/cmd-task.sh:51` (*"a new task is deliberately
left UNRANKED (I-0040/T-0092)"*), `.claude/scripts/lib/cmd-backlog.sh:6`,
`:31`, `:78`. Ruling: **D-0037** — *"Do not add auto-ranking at creation"* —
and **D-0038**, which struck the auto-rank clause from an acceptance check
rather than implement it.

**Port note.** This is recorded specifically so a later session does not
reintroduce it as a convenience. Do not default `rank` to anything.

## P-45 · There is no `scrumux secret get`, and no `scrumux task unaccept`

**What is loose.** Two capabilities are absent on purpose, and their absence
is the design:

- **No secret read-back.** `secret list` shows names and fingerprints.
  Nothing prints a value.
- **No reverse of an acceptance.** `task reject` refuses an already-accepted
  task by design; a status change carries no authority to undo a
  final-authority ruling. The sanctioned paths are `repair journal` (which
  forces a reason onto the record) or a **new** task.

**Where.** `.claude/scripts/lib/cmd-secret.sh:26`; `CLAUDE.MD`, "Secrets".
`.claude/scripts/lib/cmd-task.sh:78` carries the acceptance refusal message
in full, including the two sanctioned paths.

**Port note.** Do not add either verb as a convenience. Note that the *port*
will make both trivially easy to write, which is precisely why this entry
exists.

## P-46 · Acceptance re-runs rather than trusting a receipt — and freshness is no longer a close blocker

**What is loose (and what is deliberately *not* loose).** This one runs in
both directions and must be ported precisely:

- `task accept` **refuses** a task with no receipt, and **refuses** a red one
  (`rc != 0` or `checks_failed > 0`).
- It then **re-runs** the order's verification command itself and refuses on
  non-zero, rather than reading the receipt and believing it. A task with no
  `verification_command` cannot be accepted, because there is nothing to
  re-run — a silent skip that reports success was the measured failure.
- Receipt **staleness** is deliberately **not** a close blocker any more.

**Where.** `.claude/scripts/lib/cmd-task.sh:303-366`. Rulings: **D-0069**
(acceptance must refuse a non-green verify and must record its authority),
and **I-0139** as ruled in `DESIGN_SPEC.MD §15i`: *"Receipt freshness is no
longer a close blocker… The check moves to the moment staleness matters
rather than the moment it is cheapest to detect."* The governing tiebreaker
is `DESIGN_SPEC.MD §4`: acceptance refuses a red receipt but not a stale one,
because *"The data is not lost by declining to block — only the interruption
is."*

**Port note.** Do not re-add a freshness gate at the close. Do preserve the
re-run, including the refusal when there is no command to re-run — that
refusal exists because a silent skip printed *"VERIFIED, re-run by the
acceptor"* without running anything.

## P-47 · `issue validate` refuses **disjointness only**

**What is loose.** Self-validation is refused: an identity may not validate
an issue it raised. That is the whole check. There is no allowlist of
approved validator identities, and **User is exempt** — he may validate his
own report.

**Where.** `.claude/scripts/lib/cmd-issue.sh:58-71`:

> *"Refusal is DISJOINTNESS ONLY, deliberately. A roster allowlist was
> designed and rejected: of the identities actually in use only
> issue-validator appears in .claude/agents, so it would reject User and
> every 'claude' validation, AND — since the validator itself raises issues —
> it would make its own reports permanently unvalidatable. The human
> principal is exempt: User validating his own report is the authority this
> gate defers to, not a bypass of it."*

Manifesto Article 10 states the general rule: *"the verifier need not be a
person, but it must hold a distinct issued identity, because the constraint
is 'the verifier is not the producer', nothing more."*

**Name the bypass plainly, because the port will otherwise re-derive it or
drop it by accident.** The condition is literally
`[ -n "$ISRC" ] && [ "$ISRC" = "$BY" ] && [ "$BY" != User ]`
(`cmd-issue.sh:70`). Both sides are **caller-supplied, unverified free text**:
`--by` is whatever the caller typed, and `.source` is whatever was typed when
the issue was raised. Nothing authenticates either (P-21). And the third
clause is a **hardcoded literal** — `--by User` turns the gate off entirely.

That is deliberate and reasoned at `:67-68` — the human principal is the
authority the gate defers to, not a bypass of it — but it means the harness's
single identity-shaped gate is a string comparison over inputs it cannot
check. Article 4 holds: it claims only "these two strings differ", which is
exactly what it computes.

**Port note.** Do not add a roster check. Do not remove the User exemption.
Port the condition as written, including the case sensitivity and the literal.

## P-48 · An empty `governance/exceptions.json` is a valid journal

**What is loose.** `governance/exceptions.json` is 16 bytes — an empty
entries array. It is in `SEALED_JOURNALS`, it is schema-checked, and it
reports nothing. **A zero is a measurement.**

**Where.** `governance/exceptions.json`; `agents/lib/schema_check.py:150`
(the PAIRS row). The general principle is in `DESIGN_SPEC.MD §4` and in
Article 7: a record earns its place by use, and an empty one is the honest
shape rather than a missing feature.

**Port note.** Do not special-case empty journals out of the seal map, the
schema table, or the reports.

---

# Group H — Found while verifying this register

Five entries that exist only because the register was checked rather than
filed. **None was visible from reading the code alone** — each surfaced from
running something, or from a second party reading the same lines:

- **P-49** and **P-50** — a byte comparison contradicted an assumption made
  earlier the same day.
- **P-51** — recovered by Spike B while establishing what `repair journal`
  actually does.
- **P-52** and **P-53** — found by the independent validator, in code this
  file had already cited for something else.

All five are parity constraints a tidy port would break.

## P-49 · A seeded journal is NOT in jq's format, and stays that way until its first write

**What is loose.** `ensure_file` creates a missing journal by writing a
literal template with `printf`, not by running it through `jq`:

```sh
ensure_file() {
  [ -f "$1" ] && return 0
  mkdir -p "$(dirname -- "$1")" || die "cannot create $(dirname -- "$1")"
  printf '%s\n' "$2" > "$1" || die "cannot create $1"
}
```

The template is the compact one-liner `{"entries": []}`. jq's own rendering of
the same value is `{\n  "entries": []\n}`. So a journal that has never taken a
write is **16 bytes, not 22**, and it stays that way for ever. It becomes
jq-canonical as a side effect of the first `_write_json_body`.

Live example, measured 2026-08-31: `governance/exceptions.json` in this repo
is the seed template. It is the only one of the eleven journals here that is
not byte-identical to `jq . <file>`.

**Where.** `.claude/scripts/lib.sh:94-99` (`ensure_file`). The eight per-noun
callers are `lib/cmd-{decide,exception,health,issue,log,sprint,task}.sh` and
`lib/journal.sh:193` (`design_ensure`). `harness deploy` seeds every journal
the same way at `lib/cmd-harness.sh:556` and `:559`, so **a freshly deployed
repo has ten journals in the compact form and none in jq's** — this is the
default state of every new deployment, not an edge case.

**Port note.** Reproduce the template **bytes**, and do not route journal
creation through `jqformat`. The tempting version — "one serializer, one
format, seed it canonically" — is tidier and wrong: it makes every fresh
deploy differ byte-for-byte from bash on ten files nobody has touched, and the
differential harness reports ten failures with no behavioural cause. Note also
that `ensure_file` **does** `die` on a failed `mkdir` or write, unlike the
best-effort writes in P-09 through P-11 — it is one of the few places a
filesystem failure is fatal, because a journal that cannot be created is not a
journal.

Found by Spike A, which had asserted the opposite ("every journal on disk is
jq-canonical") before the byte comparison was actually run. Recorded here
because it is exactly the class of thing a port gets wrong by being tidy.

## P-50 · `seals.json` — the file every write touches — deliberately bypasses the guarded writer

**What is loose.** `write_json` / `_write_json_body` is described as *"the one
JSON writer"* and carries five guards: jq exit status, non-empty output, an
object-with-an-`entries`-array shape check, the entry-count-reduction refusal
(`ALLOW_ENTRY_REMOVAL`), and the ten-generation `.backups` copy.

**`seals.json` goes through none of them.** It has no `entries` array, so the
shape guard would refuse it outright. All three writers of it are hand-rolled
`jq > tmp && mv` pairs with a single `[ -s ]` check:

| Writer | Where | Guards |
|---|---|---|
| `reseal_one` | `lib.sh:341-345` | `[ -s "$_tmp" ]` only; failure sets `_rs_failed` |
| `seal_journals` | `lib.sh:386-396` | none — `printf` block, `> tmp && mv` |
| `seal_bootstrap`'s flag stamp | `lib/journal.sh:175-178` | `[ -s "$_sb_t" ]`, `2>/dev/null`, `rm -f` on failure |

It does take the journal lock (`lib.sh:325`, `:346`), so concurrency is
handled — just not shape, not backup, not count.

**The same exemption, stated explicitly, one file over.**
`lib/cmd-memory.sh` on `validator-memory.md` (the write-path exemption below
is untouched by D-0089; only the absent-file REFUSAL beside it was reversed —
see `modules/read-verbs-small.md`):

> *"validator-memory.md is PROSE, not a journal: no ids, no entries array, and
> deliberately outside SEALED_JOURNALS. So this cannot go through write_json
> (jq-only) and must not call reseal_one."*

**Port note.** Do not "fix" the inconsistency by routing `seals.json` through
the guarded writer — the `has("entries")` guard exists because *"a filter that
produces a valid object with no entries array is a filter that has silently
discarded the journal"* (`lib.sh:196-199`), and `seals.json` is legitimately
that shape. And do not add a `.backups` copy for it: it is derived from the
journals it hashes and is rebuildable, which is the same reason it is absent
from `SEALED_JOURNALS` (P-22). What **must** be preserved is the lock and the
lock order — journal first, seals second, never the reverse (`lib.sh:322-324`).

## P-51 · `repair journal`'s machinery check can fail without failing the repair

**What is loose.** After a successful repair, `repair journal` runs
`harness verify` against the repo and, if it fails, prints a `TELL` — and
**never changes the repair's exit code**. It also only runs at all in a repo
carrying `.claude/DEPLOYED`.

**Where.** `.claude/scripts/lib/cmd-repair.sh:57-79`, with the reasoning
stated inline:

> *"`harness verify`, not `harness deploy`. Deploy runs records-check and
> fails the whole install on any RECORD finding, which would drag record
> hygiene into this path every time — and record hygiene is User's to look
> at, never an agent's block (boundary 7)… It never changes the repair's exit
> code: the records are already corrected, and a drifted machinery file is not
> a reason to make that look like it failed."*

**Port note.** Two things not to unify: the choice of `verify` over `deploy`,
and the swallowed exit code. Both are boundary-7 decisions, not oversights.
Note also the deliberate **ordering** at `:36-47` — the no-op check runs
*before* `write_json`, because `write_json` now reseals the file it wrote, so
a repair that died as a no-op afterwards would have already resealed a
tampered journal and erased the mismatch with no record. The comment calls
that *"a hole, not a cosmetic ordering problem."* Preserve the order.


## P-52 · `broken_seals` compares only journals that already have a recorded key

**What is loose.** `broken_seals` iterates `.journals | to_entries[]` from
`seals.json`. A journal that is in `SEALED_JOURNALS`, present on disk, and
**has no entry in the seal map** is never hashed and never reported. It is
invisible to tamper detection rather than reported as unsealed.

**This repo is in that state right now.** `governance/exceptions.json` exists;
`jq -r '.journals | keys[]' governance/seals.json` returns **seven** names and
`exceptions.json` is not among them, against a `SEALED_JOURNALS` list of eight.

`seals_shape_problem` (P-18) catches `{}`, a non-object `.journals`, and a
zero-length map — but not a map that is merely **incomplete**, which is the
case that occurs naturally: `seal_journals` skips a journal that did not exist
at bootstrap (`lib.sh:390`, `[ -f "$GOV/$_n" ] || continue`), and nothing adds
it later until that journal takes its first write.

**Where.** `lib.sh:538-546` (`broken_seals`), `:382-397` (`seal_journals`'s
skip), `:520-536` (`seals_shape_problem`'s three cases).

**Port note.** Reproduce the iteration as-is: drive from the seal map, not
from `SEALED_JOURNALS`. A port that iterates the canonical list and reports
"no recorded seal" for the difference has invented a finding this system does
not raise. Surfaced by the Phase 0 validator; see OQ-19.

## P-53 · `capture_report` discards the report's stderr and its exit status

**What is loose.** Under `--json`, a report verb runs through
`capture_report`, which redirects its prose to a file and **throws its stderr
away**:

```sh
"$@" > "$_cr_f" 2>/dev/null
```

The function's return value is never examined either. So a jq parse error
inside a report section vanishes entirely under `--json`, while in human mode
the same error would appear on the terminal. The two output modes differ in
what an operator can see.

**Where.** `.claude/scripts/lib/cli.sh:146-156`, the redirect at `:150`. The
header explains the *capture* (a report IS its prose, so suppressing it under
`--json` would hand a caller an empty object) but does not address the
discarded stderr.

**Port note.** This is a real asymmetry between the two modes, and it is why
`status session` can render a brief with silently wrong counts under `--json`
— the P-16 refusal is printed *into* the captured prose, so it survives, but
anything jq writes to stderr does not. Port the redirect as written. Surfaced
by the Phase 0 validator; see OQ-20.


---

# What this register is NOT

**It is not a licence to stop thinking.** A port is allowed to be faster,
clearer and better-structured. Six entries here are explicitly about
*behaviour*, and behaviour-preserving performance work (one parse per journal,
no subprocess `jq`/`shasum`/`awk`, the conf compiled once per process) is
sanctioned by the plan.

**It is not a claim that every one of these is right.** Several read as
defects and may be. The rule is about *who decides*: the builder surfaces
them, User rules, and an accepted change lands as a `decide` record plus an
`APPROVED-DIVERGENCE` marker. What is prohibited is the change arriving
without either.

**It is not exhaustive.** Nineteen noun modules, 38 test suites and 84
decisions were read for this pass; the four hooks, `lib.sh`, `lib/cli.sh`,
`lib/journal.sh` and `schema_check.py` were read line by line. Per-module
inspection continues in `docs/port/modules/<name>.md` (plan §"Simplify/perf
assessment"), and each of those adds its own "Deliberate looseness" section
back into this register.

## How this register was checked

Eighteen of its load-bearing claims went to an **independent validator** with
no part in writing it, with instructions to confirm or refute each against the
tree, to default to REFUTED without direct evidence, and to say what is
actually true when it refuted. Result: **13 confirmed, 3 partial, 2 refuted**,
plus 10 loosenesses the register did not contain.

Every refutation is corrected in place above and the correction says what the
entry first claimed, because the pattern in them is the useful part:

| Entry | First claim | What is true |
|---|---|---|
| **P-02** | `status session` has no non-zero path | argv exits 2; **`jq` absent exits 1** |
| **P-16** | `backlog` disposes of the tri-state by exiting 1 | `backlog` never calls `read_journal` and exits 2 |
| **P-32** | only `rm` with both `r` and `f` is uncovered | **`rm --recursive --force` also passes** |
| **P-37** | rules/skills drift never fails | never fails **for content**; a *missing* file does fail |
| **P-04** | a red `lint` is a TELL | ...and so is a `lint` that **times out** |
| **P-13** | `reseal_one` reports and returns 1 | the 1 is swallowed by `journal_unlock` |
| **OQ-6** | the duplicate `--desc` was never real | it was real, survived the consolidation, removed in `e59b606` |

Three claims flagged "not verified" were then **reproduced** rather than left
as readings — OQ-4 (a reasonless refusal), OQ-7 (`next_id` re-issuing a live
id), and the `rm` flag matrix in P-32.

The through-line: **every one of the two refutations and both wrong readings
came from trusting a contract the code states about itself** — a header
comment, a test name, a design record — instead of running it. That is the
specific failure this port is most exposed to, because the bash source is
unusually well commented and the comments are unusually persuasive.

---

# Open Questions

**These are surfaced, not fixed.** Each is something that looked wrong while
reading, that I could not trace to a ruling or a comment establishing it as
deliberate. **None of them is being changed in the port.** Each needs
User's ruling; until it comes, the TS implementation reproduces the bash
behaviour exactly, including any behaviour named here as suspicious.

Where I could not establish intent, I say so rather than asserting a defect.

### OQ-1 · The Prime Article vs. `git push --force-with-lease`

The destructive wall blocks a bare force-push and **exempts**
`--force-with-lease`. But the Prime Article says the harness does not block
the *user*, and `CLAUDE.MD` reserves push to User. A hook cannot tell a
user-initiated push from an agent-initiated one. Is the current split (bare
force blocked, lease allowed) the intended reading, or should the wall's
message change now that the manifesto is written?

*Not a proposal to change behaviour — a question about whether the manifesto
changed the reading.*

### OQ-2 · `unsupported_keywords()` has no caller

`agents/lib/schema_check.py:49-62` exists to report schema keywords the
validator ignores. `main()` (`:161-181`) does not call it, and a repo-wide
grep finds no caller anywhere:

```
agents/lib/schema_check.py:49:def unsupported_keywords(...)
agents/lib/schema_check.py:58:  out.extend(unsupported_keywords(...))   # recursion
agents/lib/schema_check.py:61:  out.extend(unsupported_keywords(...))   # recursion
```

So in the live path an unsupported keyword **is** silently ignored — the
exact outcome the module docstring says the function exists to prevent. The
docstring also names `_UNSUPPORTED`, which is not a symbol in the file
(`_KNOWN` is).

Three readings, and I cannot distinguish them from the tree: (a) a library
function for a caller that was never written; (b) a caller that was deleted
in the T-0184/T-0186 contraction; (c) an oversight. **Question for User:**
should the TS port call it (a behaviour change — new output on
`records check`), or port it unwired exactly as it is?

*Recorded as: not fixed. The TS port reproduces the unwired state.*

### OQ-3 · `design.json` is never schema-checked

`schema_check.PAIRS` (`:144-158`) lists seven journals. `design.json` is not
among them, and `.claude/schemas/design.schema.json` exists and is shipped in
the payload (`cmd-harness.sh:193` ships the module; the schema ships with
`.claude/schemas/`). So epics, features, stories, surfaces and controls are
written with write-time field validation in `cmd-epic/feature/story.sh` but
are never validated against their schema.

`rule-frontmatter.schema.json` is likewise unvalidated by this path — though
`cmd-records.sh:317` does check that a rule *has* frontmatter with `name` and
`paths`, citing that schema by name.

Probably deliberate (design.json is `{entries:[…]}` with a `kind`
discriminator, and `check_journal` validates every entry against **one**
schema, which a polymorphic journal breaks). **Not verified as deliberate —
no comment or decision says so.** Question: is the absence intended, and
should the register record it as such?

### OQ-4 · `walls_reason` can return empty, producing a reasonless refusal

`walls_reason` (`walls-lib.sh:98-112`) returns the text after the last pipe
for the first matching conf rule. If `walls_refuses` matched on the *merged*
alternation but no individual rule matches the same string on its own second
pass — possible when an invalid pattern was skipped by `walls_field` between
the two calls, or when the fail-closed branch fires — the message becomes:

```
BLOCKED by project-walls.conf:
```

...with nothing after the colon. Article 5 says a refusal that states a fact
without naming the next action is a defect; a refusal that states *nothing*
is further along the same axis.

**REPRODUCED.** The route is simpler than the one guessed above: a `refuse`
line whose reason after the pipe is **empty**. `walls_field` keeps such a line
because `:53` filters on `grep -F '|'` — the presence of a pipe, not of text
after it — and `:56` skips only a line whose *pattern* is empty. The rule
therefore joins the refuse alternation and fires, while `walls_reason`'s
`sed -E 's/^.*\|[[:space:]]*//'` (`:108`) yields "".

With `refuse zzdanger|` in a scratch `project-walls.conf` and the command
`zzdanger --now`:

```
$ od -c stderr
0000000  B L O C K E D   b y   p r o j e c t - w a l l s . c o n f :  \n
```

rc=2, nothing after the colon. Whitespace-only after the pipe
(`refuse zzdanger|   `) gives byte-identical output. The recorded event
carries `"reason": ""` too (`walls-lib.sh:316`), so the empty string also
reaches the diagnostics stream the wall records exist to feed.

Note the second-order effect: such a rule is **silently active**, unlike an
uncompilable pattern, which is named on stderr at `:61`. A repo can have a
live wall rule it never gets told about.

Behaviour is ported as-is.

### OQ-5 · `enforcement-posture.md` names two deleted files as live sites

Its table has rows for `.claude/scripts/validate` (four rows) and
`.claude/hooks/monitor-compliance.sh` (one row, described as *"the only
log-tier site in the harness"*). Neither file exists. The file's own header
declares stale rows are not findings (P-42), so this is *declared* stale
rather than undeclared — but the monitor row is the sole documentation of a
whole tier, and D-0072 boundary 7 still names three dispositions
(block/tell/log) of which `log` now has no implementation.

**Answered while validating, and the answer is that the tier is gone.**
Confirmed: `.claude/scripts/validate` and `.claude/hooks/monitor-compliance.sh`
do not exist. `cmd-harness.sh:413` and `tests/harness-tests.sh:668` both record
that **T-0186 deleted the monitor and removed the PostToolUse chain**, and
`.claude/settings.json` now declares only `PreToolUse` and `SessionStart`. The
CLI result vocabulary (`lib/cli.sh:96-100`) is pass/fail/warn/tell/note — there
is no `log`.

So `enforcement-posture.md:33`, *"Three dispositions, per D-0058 — block
rarely, tell mostly, log always"*, describes a **two-tier** system, and
D-0072 boundary 7 still names three.

**Question, narrowed:** does the port carry a `log` tier forward as a concept
(Phase 7 and the app both have a plausible use for it), or is "block rarely,
tell mostly" the settled vocabulary and the third word should stop being
quoted? Not a code question — nothing implements it either way.

### OQ-6 · `CLI-CONSOLIDATION.md §12` records a duplicate `--desc` that is no longer there

§12 reports *"`scrumux task new` accepts `--desc` twice in its flag loop —
the second arm is unreachable. Harmless, and left alone."* I checked: today
`cmd-task.sh` has `--desc` once in `task new` (`:23`) and once in
`task update` (`:239`) — two different flag loops, no duplicate.

**My first reading of this was wrong, and the history is worth having.** The
duplicate was real, it survived the consolidation, and it was removed later:

- `git show b060938^:.claude/scripts/scrumux` — `--desc) DESC=${2?}; shift 2;;`
  at **:486 and :491**, both inside the single `task new` case. A genuine
  unreachable arm.
- `git show b060938:.claude/scripts/lib/cmd-task.sh` — still duplicated, at
  `:23` and `:28`, both in `task new`. The consolidation moved it verbatim,
  exactly as §12 said it would.
- Removed in **`e59b606`**, *"CLI-23: residue cleanup across the CLI scripts
  and README"*.

So `CLI-CONSOLIDATION.md:710-713` was accurate when written and is now stale
documentation. **This is a stale line in a design record, not a code defect**
— recorded so the port does not go hunting for a duplicate that is not there,
and so the design record is not read as describing today's code.

### OQ-7 · `next_id` will crash on a malformed id, and the failure is silent-ish

`next_id` (`lib.sh:598-602`) does `ltrimstr($p) | tonumber` over every id in
a stream. A journal containing an id whose suffix is not numeric — say
`T-000A`, or an id written by a future scheme — makes `jq` error, the pipe
yields nothing, `read -r n` fails, and `n` defaults to `1`. The allocator
then hands out `<prefix>-0001`, which almost certainly already exists.

**REPRODUCED.** Scratch `GOV_ROOT`, `tasks.json` containing `T-0001` and
`T-000A`:

```
$ next_id "$GOV/tasks.json" ".entries[].id" T
jq: error (at .../tasks.json:1): Invalid numeric literal at EOF at line 1, column 4 (while parsing '000A')
T-0001rc=0
```

jq dies mid-stream, the pipe yields nothing, `read -r n || n=1` (`lib.sh:601`)
defaults, and the allocator returns **`T-0001` — an id already in the
journal — at rc 0**. The jq error goes to stderr and nothing in `next_id` or
`append_with_id` inspects it.

This sits directly on the CLI-14 duplicate-id class the port is meant to
close, and no comment says the behaviour is intended. Under Article 4 the
current shape reports something it did not compute. No such id exists in any
live journal today, so it has never fired.

**Not being changed.** Surfaced because the write engine is being rebuilt in
Phase 4 and this is exactly the kind of thing that gets "obviously" fixed on
the way past.

### OQ-8 · POSIX ERE vs JS RegExp: whose semantics govern a `project-walls.conf` line?

Every wall pattern — the built-ins **and** every user `refuse`/`allow` line —
is a POSIX ERE evaluated by `grep -E`. The port evaluates them with
`RegExp`. The two disagree in ways that matter here: backreferences,
`\d`/`\w`/`\b` (ERE has none — `grep -E` treats `\d` as a literal `d` on some
implementations), bracket expressions like `[[:alpha:]]`, leftmost-longest
alternation, and the treatment of an unescaped `{`.

A pattern a repo wrote and tested against `grep -E` may match differently, or
throw, under `RegExp`. `walls_field`'s per-pattern compile check
(P-28) would skip a pattern JS rejects — **silently narrowing a repo's
declared wall extension**, which is the fail-open direction on a `refuse`
line.

**Question for User:** when an ERE cannot be faithfully translated, does the
port (a) skip and name it, exactly as bash does for an invalid pattern; (b)
fail closed and refuse; or (c) refuse at *write* time in Phase 7's
`scrumux wall refuse`, so the problem never reaches the hook? The plan
already names `ere.ts` and property-testing against real `grep -E`; this
question is about the residual that does not translate.

### OQ-9 · Number formatting is the only place `jq .` cannot be reproduced from JS values

Established by Spike A (`docs/port/spikes/A-jqformat.md`): every live journal
and every structural/string/unicode edge case reproduces byte-for-byte, and
the **only** divergence class is numeric. Two sub-cases need a ruling:

1. jq preserves an unmodified number's **literal digits** (`1.10` stays
   `1.10`); `JSON.parse` does not. The port must parse numbers as raw text to
   match. That is a design constraint, not a question.
2. jq **refuses** a lone surrogate escape (`"\ud800"`) that a JS parser
   accepts. Here the TS port would be **looser than bash**, which the
   anti-strictness rule permits but the differential harness will flag as a
   divergence.

**Question:** is (2) recorded as an accepted divergence, or does the port
match jq's refusal? Matching it would be *tightening*, which is why this is a
question and not a decision.

### OQ-10 · The four rulings D-0082 names still read as gates

D-0082 records that D-0004, D-0005, D-0015 and D-0016 say a check FAILS where
the code now warns, and upholds the demotions. But the decision entries
themselves were not amended — an agent reading D-0004 today still believes a
gate will stop it that will not.

The port does not change any of this. **Question:** should the TS surface do
anything about it — for instance, should `ref_resolve` learn to say
"amended by D-0082" the way it already says "SUPERSEDED by" — or does this
stay a documentation matter for the app?

*Raised because Phase 7's amendment model is the natural home for it, and
deciding now is cheaper than deciding after that surface is built.*

### OQ-11 · `walls_can_read_file` and `walls_can_call_out` are fixed word lists

Both are `grep -qxE` against a hardcoded alternation
(`walls-lib.sh:241-250`). The secret wall's list omits readers the handoff
already named as holes (`dd`, `nl`, `tac`, `bat`, `vim`, `view`, `ex`, and
`busybox`/`toybox` multiplexers), and Phase 1a of the approved plan fixes
that **in bash, first**, so the parity spec is correct.

Listing it here for completeness only: this is the one known-loose thing that
is scheduled to be tightened, and it is being tightened **in bash before the
port**, under a recorded plan step — which is the sanctioned route. The port
must not tighten it independently or ahead of 1a.

### OQ-12 · Deploy unions `permissions.allow` but nothing prunes it

P-36's exception appends canon allow rules and **never removes** one. A rule
that upstream has since dropped — because it named a command that no longer
exists, or was too broad — stays in every deployed repo permanently, and
there is no verb to clear it.

Symmetric with the problem `reseal_one`'s pruning half was written to fix
(`lib.sh:327-339`: *"a seal written by an older harness for a file the
current SEALED_JOURNALS excludes survived for ever"*). No comment or decision
addresses the allow-list case.

**Not verified as a live problem** — I did not check whether any currently
deployed repo carries a stale allow rule. Surfaced as a question because the
precedent for pruning exists one file away and the reasoning is identical.
Behaviour is ported as-is.

### OQ-13 · `repair journal` discards jq's stderr, then refuses with a generic message

`.claude/scripts/lib/cmd-repair.sh:43`:

```sh
jq "$EXPR" "$GOV/$JF" > "$_chk" 2>/dev/null || { rm -f "$_chk"; die "repair: the jq expression failed against governance/$JF — check the filter"; }
```

jq's own diagnostic — which names the syntax error and its column — goes to
`/dev/null`, and the author of a broken filter is told only "check the
filter". Article 5 says the error message is the instruction set and that a
refusal stating a fact without naming the next action is a defect; here the
information needed to act was computed and then thrown away.

This sits on `repair journal`, which the code itself calls *"the most
consequential write in the CLI"* and which is the command a person reaches for
when a journal is already damaged.

No comment or decision explains the `2>/dev/null`. **Not verified as
deliberate.** Surfaced by Spike B and confirmed at source; behaviour is ported
as-is.

### OQ-14 · The repair filter is executed twice, and only the first run is hashed

`cmd-repair.sh:43-48` runs the filter once into a temp file, hashes the result
to decide whether the repair is a no-op, deletes the temp file, and then calls
`write_json`, which **runs the same filter again** to produce the bytes that
actually land.

A filter that is not a pure function of the journal — one using `now`,
`$ENV`, `input_line_number`, or `--argjson` derived from a clock — would be
compared on one output and would write a different one. The no-op guard and
the seal would then describe bytes that were never written.

Spike B recovered all 31 historical `--apply` filters from `governance/log.json`
and **none is impure**, so this has never fired. It is also cheap to avoid —
`mv` the checked temp file into place rather than re-running — but that is a
change to the write path, which is exactly what this file forbids doing
quietly.

**Question:** accept the double execution as-is for parity, or record a
divergence in Phase 4 that writes the already-computed bytes? Recommend
ruling before the write engine is built rather than after.


### OQ-15 · A `lint` check that times out is reported TELL and never counted

`lib.sh:750-753` tests `rc == 0`, then `type == lint`, then `rc == 142`
(SIGALRM from `run_with_timeout`). Because the `lint` arm comes first, a
lint-typed check that **hangs for its entire timeout** is reported `TELL` and
is not counted in `hc_fails` — indistinguishable from a lint that ran and
found something.

T-0144's reasoning is about a linter's *findings* not turning a repo red. A
linter that never finished produced no findings. **Not verified as
deliberate** — no comment addresses the ordering.

**Question:** should a TIMEOUT outrank the `lint` carve-out? Behaviour ported
as-is either way.

### OQ-16 · `read_journal`'s header names a caller that does not call it

`lib.sh:119-121` says *"backlog exits 1, status prints the refusal INTO the
brief and still exits 0."* Measured: `cmd-backlog.sh` never calls
`read_journal`, hand-rolls the check three times, and exits **2**.

Two smaller things fall out of the same reading, both **inference, not run**:
`cmd-backlog.sh:39` in the `--features` branch is
`[ -f "$GOV/tasks.json" ] && TASKSJSON=$(cat "$GOV/tasks.json")` with no
`jq -e` guard, so a corrupt `tasks.json` there reaches `--argjson tj` — the
I-0102 shape the guarded reader exists to prevent, in the one branch that
still cats unchecked.

**Question:** is backlog's exit 2 the intended code (it is arguably the
*better* one — "could not run" rather than "assertion failed"), making the
comment stale? Or was exit 1 intended? The port needs to know which to
reproduce.

### OQ-17 · The destructive wall does not cover GNU long flags

Measured against the real hook: `rm --recursive --force <path>` returns
**rc=0** and is not blocked, as does `rm -rd <path>`. Both perform the act the
wall names. The regex at `block-destructive.sh:252` is short-flag-only.

macOS `rm` does not accept `--recursive`; GNU coreutils does, and the port's
whole purpose is running on platforms this one never did. **A Windows/Linux
user's `rm --recursive --force` is not covered by a wall its documentation
says covers recursive force deletes.**

Recorded, not fixed. This is a wall change and belongs to a ruling. Noting the
relevant precedent: the handoff schedules exactly this kind of gap-closing for
the *secret* wall in Phase 1a, **in bash, before the port**, so the parity spec
is correct — the same route is available here.

### OQ-18 · `reseal_one`'s failure status is swallowed by `journal_unlock`

`lib.sh:354` returns 1 on a failed reseal; `_write_json_body` ends with that
call (`:284`) so the status propagates — and `write_json` (`:291-295`) then
ends with `journal_unlock`, which is `rmdir … || :` and always 0. No caller
can see it. Only the stderr line at `:353` survives, and under `--json` that
line is unstructured while stdout carries the one object.

The comment at `:347-350` says the message was added *because* the function
"returned 0 on its own write failure". Half the fix landed.

**Question:** is the stderr line the intended whole remedy, or should the
status reach the caller? Note that making it reach the caller would change a
write verb's exit code — a differential-visible change, hence a ruling.

### OQ-19 · A sealed journal with no seal entry is invisible, not unsealed

See P-52. `governance/exceptions.json` is live in this state today: on disk, in
`SEALED_JOURNALS`, absent from `seals.json`'s seven keys. Nothing reports it,
and `seals_shape_problem` does not cover an incomplete map.

**Question:** should an incomplete seal map be a `records check` warning (the
P-07 treatment — named, never fatal), or is silence correct because the
journal seals itself on its first write? Behaviour ported as-is.

### OQ-20 · `--json` and human mode disagree about what an operator can see

`capture_report` discards a report's stderr (`lib/cli.sh:150`) and
`repair journal` discards jq's (`cmd-repair.sh:43`, OQ-13). In both cases the
information exists and is thrown away, and in both cases `--json` is the
lossier mode.

Article 5 makes refusal text load-bearing product surface. **Question:** is
there a general ruling here — that a diagnostic suppressed under `--json`
belongs in the envelope (`error.detail`, or a `note` row) rather than nowhere
— or is per-site the right granularity? Raising it once rather than three
times, because the port touches every one of these sites.


---

## Sign-off

This register is a **Phase 0 gate artifact**. Per the plan, the phase does
not close until User signs it alongside the Promises-Kept audit. Until then
no TS code is written that depends on any behaviour described here.

Anything added to this file later — from a per-module inspection, from a
differential surprise, or from a reader — is **appended**, never edited in
place. The reasoning that was true at the time is the part worth keeping.
