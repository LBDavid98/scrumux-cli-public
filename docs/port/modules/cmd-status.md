# Module inspection — `cmd-status` (`.claude/scripts/lib/cmd-status.sh`, 403 lines)

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

Read line-by-line (all 403 lines), plus `lib.sh:95-273` (`read_journal`,
`journal_unreadable`, `design_view`, `ref_journal`), `lib/cli.sh:1-214`
(`_row`/`row_*`, `say`, `capture_report`, `emit`, `die`/`die_usage`,
`cli_finish`), and `tests/status-tests.sh` (368 lines, the dedicated suite),
`tests/cli-shape-tests.sh:70-270`, `tests/records-sweep-tests.sh` (254 lines,
covers `status sweep`), `tests/lib-scripts-tests.sh:74,247-290` (`read_journal`
contract), `tests/readonly-sh-tests.sh:47`, `tests/hook-upstream-tests.sh:124-143`
(wall interaction), `tests/scrumux-tests.sh:353-354` (superseded-decision
exclusion). Three behaviors below were reproduced against the live tree with
crafted `GOV_ROOT` fixtures (commands and output shown inline) rather than
inferred from the source, per the validation standard for this pass.

## Intent

`cmd-status` is the `status` noun: four read-only report verbs —
`session`, `sprint`, `sweep`, `planning` — that replaced four separate
top-level scripts (`session-brief`, `sprint-status`, `issues-pending-validation`,
plus the old `scrumux`) because they re-opened the same seven journals
independently, "three of them in the same planning breath and two of them
in the same session start" (cmd-status.sh:5-8). `status session` is wired to
Claude Code's `SessionStart` hook (`settings.json`, asserted at
status-tests.sh:157-158) and is the one surface every session opens with.

**Why it can never fail.** cmd-status.sh:14-17 states the contract inline:
*"`status session` NEVER exits nonzero... a failure there would be a failure
to start work."* Mechanically this holds because the module contains **zero
`row_fail` and zero `row_warn` calls** — grepped, confirmed absent — so
`CLI_OK` (cli.sh:52,83) is never set to 0 by anything this module does. The
only non-zero exit is `die_usage` on surplus argv (cmd-status.sh:362,378) →
exit 2 via `_cli_refuse` (cli.sh:184-198), which is "could not run," not "the
records said no." `status_tell_unfinished` (cmd-status.sh:400-403) is the
module's one `row_tell` call and — per the published API's contract
(cli.sh:19-21) — a tell can never move `CLI_OK`.

**The journal-loading layer** (cmd-status.sh:21-95) exists to give every
section a journal "opened at most once per run" (the stated design at
cmd-status.sh:22-23): `jload NAME path` is the general-purpose memoized
loader keyed by a `LOADED_$NAME` flag; `load_tasks`/`load_design` are
bespoke memoized loaders for the two journals more than one section needs in
a shape other than raw content (`T_VIEW`, a compact seven-field projection
of a 690KB file, and `DESV`, `design_view`'s per-kind projection). All three
route through `lib.sh`'s `read_journal` (lib.sh:131-138), which is
**tri-state**: absent → default `{"entries":[]}`, rc 0; parses → file
contents, rc 0; present-but-not-JSON → nothing on stdout, rc 1. On the
rc-1 path, cmd-status.sh's own `refuse_journal` (cmd-status.sh:39-44) prints
one line naming the file and the repair command **into the report itself**
(never onto the exit code), and dedups by exact path in the `REFUSED`
accumulator so a journal opened by two different loaders — `tasks.json` is,
by both `load_tasks` and `jload TASKS` — still reports its refusal exactly
once. This is asserted directly at status-tests.sh:120-123 ("emitted ONCE...
a journal read by two sections must refuse once").

**Section mechanics, briefly:**
- `section_session` (cmd-status.sh:268-331): git position (git position
  guard discussed under Open Questions), the sprint verdict + in-flight
  block (uncapped — see below), `in_progress`, `awaiting User` (an
  `in_review` task with no `acceptance.accepted == true`, D-0076/T-0187),
  three-line log/decision tails (superseded decisions excluded,
  cmd-status.sh:321-323), and an open-issues count.
- `section_sprint` (cmd-status.sh:136-235): five labelled blocks — sprints
  in flight, epic coverage, tasks not sprint-ready, open issues, and
  dependency-ordered sprint candidates that explicitly exclude any task
  already claimed by a **proposed or ratified** sprint (T-0094/I-0039,
  cmd-status.sh:212-217) so the same task never appears with two conflicting
  "add me" hints in one report.
- `section_sweep` (cmd-status.sh:246-259): open issues with neither
  `validation` nor `authorization` recorded — the T-0042 planning-entry
  sweep, User-inspection surface, not a gate (records-sweep-tests.sh:1-9).
- `status_planning` (cmd-status.sh:392-398): `section_sprint` +
  `section_sweep` under one header, so `capture_report` has one function to
  run rather than four whose output would each need its own `.data.lines`
  key (comment at cmd-status.sh:389-391).

**The no-cap decision (I-0122) is load-bearing and specifically anti-regression.**
cmd-status.sh:282-297 documents that the brief used to end in `| head -8` —
one header plus seven task lines — which silently dropped whole sprints
(two five-task sprints hid four tasks each; a nine-task sprint hid the
*next* sprint's header too, because the cap counted header lines against the
same budget as task lines). The fix removed the cap entirely and kept one
`grep -E '^SP-|^  T-'` filter, which is **not** decorative: a task title
containing an embedded newline emits a bare, unindented continuation line
that the filter's anchors exclude (T-0204). Both properties are exercised in
status-tests.sh:265-339 with a synthetic 9-task sprint, a synthetic two-sprint
(5+5) fixture, and a title containing a literal `\n`.

**Compactness is a *tested* budget, not a *code-enforced* one.** status-tests.sh:90-92
asserts the empty-repo brief is ≤30 lines via `wc -l` on the test fixture; no
truncation logic exists in the module to enforce this on a large repo — the
comment at cmd-status.sh:288-290 says sprint size is bounded by "D-0006
atomicity and task-lint," not by anything in `status`.

## Deliberate looseness

1. **`status session` exits 0 for every state of the records — argv is the
   one exception, at exit 2.** PHILOSOPHY.md **P-02**. Directly measured
   here too (empty root, nonexistent `GOV_ROOT`, all-corrupt journals, all
   under `--json`) — every one of those returns rc 0; `status session bogus`
   returns rc 2 via `die_usage` at cmd-status.sh:362.

2. **Absence vs. unreadable-content is a three-way contract, and the
   printed refusal is inside the report, never on the exit code.**
   PHILOSOPHY.md **P-16**. cmd-status.sh is `read_journal`'s only consumer
   (`lib/cmd-status.sh:52,72,90` — confirmed, `read_journal` has exactly
   three call sites total and all three are in this file). `design.json`'s
   guard deliberately sits in `load_design` (cmd-status.sh:82-95) rather
   than inside `lib.sh design_view`, because `design_view`'s other caller
   (`records-check::sweep_structure`) must not inherit a brief-shaped
   refusal sentence.

3. **A ratified sprint with unfinished tasks no longer blocks planning or
   reporting — it TELLs.** PHILOSOPHY.md **P-06**, whose table names this
   exact site: *"`status` — reporting while a sprint has unfinished tasks |
   it is a read-only report."* Mechanically: `status_tell_unfinished`
   (cmd-status.sh:400-403) calls only `row_tell`, and `sprint_verdict_line`
   (cmd-status.sh:127-133) always prints a VERDICT sentence either way —
   D-0004 was the removed gate, T-0144 made it advice, and both the
   `sprint`/`planning` (row_tell) and `session` (verdict sentence only, no
   row at all) surfaces say so without ever touching `CLI_OK`.

4. **`capture_report` discards a report function's stderr under `--json`,
   and this is directly observable through `status`.** PHILOSOPHY.md
   **P-53**. `status sprint`/`session`/`sweep`/`planning` are the concrete
   example the entry cites (PHILOSOPHY.md:1407-1409 names `status session`
   by name). Reproduced live for `status sprint` in the Open Questions
   section below.

5. **NEW — candidate-status exclusion follows "proposed OR ratified," not
   just "ratified."** No PHILOSOPHY.md item covers this (grepped for
   `I-0039`/`T-0094`: absent). A task attached to a sprint that is merely
   **proposed** — not yet ratified by User — already disappears from
   "Candidates for next sprint" (cmd-status.sh:216-217,
   `select(.status=="proposed" or .status=="ratified")`), and only
   reappears there if that sprint is later abandoned
   (status-tests.sh:213-217 exercises exactly the abandon-releases-it
   case). This is deliberate and tested (I-0039: a task must never carry
   two conflicting "add me" hints in one report — comment at
   cmd-status.sh:212-215 measures the prior failure as six duplicate
   "READY" hints in one run), but it is a genuine behavioural choice a
   porter could plausibly narrow to "ratified only" while believing it a
   cleanup. Candidate for the register.

6. **NEW — the session brief's task list has no size cap, on purpose, and
   this was a fix, not an original design.** No PHILOSOPHY.md item covers
   I-0122. cmd-status.sh:282-297 (cited under Intent above) is exactly the
   kind of "surely this needs a bound for context budget" temptation a
   porter will feel, and reversing it silently re-creates a measured defect
   (whole sprints, including a second sprint's header, vanishing from the
   brief with no indication anything was cut). Candidate for the register.

7. **`refuse_journal`'s per-path dedup is a property of `cmd-status.sh`
   itself, not of `read_journal`.** Adjacent to P-16 but not the same
   claim — P-16 is about `read_journal`'s three return states; the
   at-most-once-per-file *printing* guarantee across multiple loaders
   (`load_tasks` + `jload TASKS` both target `tasks.json`) is this module's
   own `REFUSED` accumulator (cmd-status.sh:38-44), verified at
   status-tests.sh:120-123. Not flagged NEW because it is unambiguously in
   service of P-16's stated principle ("a journal loaded by two sections
   must not say the same thing twice," cmd-status.sh:36-37) rather than a
   separate design choice — noted here so a porter does not mistake the
   *mechanism* (one `REFUSED` set, checked before every print) for
   incidental and drop it while preserving only the tri-state read.

## Simplify/perf

**BEHAVIOR-PRESERVING:**

- **Subprocess count is the real budget risk for a ≤150ms target.** A
  single `status session` call over a populated repo currently forks
  roughly 3 `git` processes (`rev-parse --git-dir`, `git log -1`, `git
  status --porcelain`, cmd-status.sh:275-276) plus on the order of 15-18
  `jq` invocations: one `jq -e .` validity check per journal read
  (`read_journal`, lib.sh:136) **plus** a separate `jq -r`/`jq -c`
  projection per computed value (`T_VIEW`, `ACTIVE`, `FLIGHT`,
  `UNFINISHED`, `RATIFIED`, `IP`, `WAIT`, `PROP`, two separate passes over
  `J_ISSUES` for the count and the id-list, the log tail, the decision
  tail) — each one a process fork+exec. A TS port that keeps a
  subprocess-per-jq shape (shelling to a real `jq` binary, or even
  `child_process.exec` per lookup) reproduces this cost with none of the
  bash startup savings and will very plausibly blow a 150ms budget on a
  cold path; doing every projection in-process over one parsed object per
  journal (this port's own front-matter sanctions this: "one parse per
  journal, no subprocess jq/shasum/awk") is the fix, and it is
  behavior-preserving as long as the *text* every projection currently
  produces is reproduced exactly.

- **`tasks.json` is read and validated twice per `status session` call for
  no output difference.** `load_tasks` (cmd-status.sh:63-79) reads it once
  to build `T_VIEW`; `jload TASKS` (cmd-status.sh:307, inside
  `section_session`) reads the **same file** again to build `J_TASKS` for
  the `awaiting User` line. Both go through `read_journal`, so a corrupt
  file is validated (and refused, once, per item 7 above) twice. Caching
  the parsed journal once and deriving both `T_VIEW`'s projection and the
  `awaiting User` filter from the same in-memory object removes one full
  read+validate+jq pass with zero change to any printed line — this is
  exactly what the module's own header (cmd-status.sh:22-23, "opened at
  most once per run") already claims and does not currently do for this
  one file.

- **`open issues` in `section_session` runs two separate `jq` passes over
  the same `J_ISSUES` content** — one for the count (cmd-status.sh:327,
  `length`) and one for the id list (cmd-status.sh:328) — where a single
  filter emitting both values in one pass produces identical text with one
  fewer subprocess.

- **The load-bearing `grep -E '^SP-|^  T-'` filter (cmd-status.sh:297) is a
  plain per-line prefix test**, not a general regex feature the port needs
  a full ERE-to-JS-RegExp translation layer for — an in-process
  line-by-line `startsWith('SP-') || startsWith('  T-')` check reproduces
  it exactly with no subprocess and no regex-dialect risk (see Open
  Questions for why this filter's *exact* per-line semantics still matter).

- **`capture_report`'s CLI-mode toggle** (cli.sh:146-156 — flip `CLI_JSON`
  off, redirect a report function's stdout to a temp file, flip it back,
  wrap the file as `.data.lines`, discard stderr) is the general
  mechanism `status` runs every verb through. In TS this becomes an
  explicit sink object passed to the report builder (collect lines into an
  array; discard/attach errors per the `--json` flag) rather than a global
  mutable mode flag plus a real file redirect — same contract
  (lines captured verbatim, stderr swallowed under `--json`, not swallowed
  in human mode), no behavior change.

**No OBSERVABLE proposals for this module.** Nothing found here is a case
where the *right* fix is a visible behavior change User would need to rule
on: the closest candidate (validating journal *shape*, not just JSON
syntax — see Open Questions) is explicitly a new validation, which the
hard rule for this pass forbids proposing.

## Open questions

1. **A journal that is syntactically valid JSON but the wrong *shape*
   produces a silently-wrong report at exit 0, human mode leaks the jq
   error to stderr, and `--json` mode swallows it completely.**
   `read_journal`'s validity check is `jq -e .` (lib.sh:136) — "is this
   JSON at all," not "does it have `.entries` as an array." Reproduced
   live:

   ```
   $ printf '{}' > $GR/governance/sprints.json   # valid JSON, wrong shape
   $ GOV_ROOT=$GR .claude/scripts/scrumux status sprint
   jq: error (at <stdin>:0): Cannot iterate over null (null)
   .claude/scripts/lib/cmd-status.sh: line 108: [: : integer expression expected
   .claude/scripts/lib/cmd-status.sh: line 146: [: : integer expression expected
   rc=0
   --- Sprints in flight ---
   (none proposed or ratified)          # false: the file is not empty, it is malformed
   ```

   Under `--json` the same fixture produces **zero** stderr, `.ok: true`,
   `.exit: 0`, and `.data.lines` reads exactly like a genuinely empty
   `sprints.json` — a machine consumer has no way to distinguish "no
   sprints" from "sprints.json is garbage." The same class reproduces on
   `tasks.json = {}` inside `status session` (two `jq` errors, `WAIT` and
   `in_progress` both silently fall back to their `none` defaults). This is
   the same *class* of problem I-0102/T-0163 (P-16) already fixed for
   "does not parse as JSON" — it is not fixed for "parses, wrong shape,"
   and nothing in the tree (comment, ruling, test) treats that as
   deliberate. Surfaced, not fixed, per the hard rule against proposing new
   validation: file:line — `cmd-status.sh:106-108` (`ACTIVE`),
   `:116-118` (`UNFINISHED`), `:307-310` (`WAIT`), `:72-74` (`T_VIEW`, the
   one site with an explicit `|| T_VIEW='[]'` fallback — the others have
   none). A TS port should reproduce this exact gap (silent-wrong, not
   silent-refuse) rather than "fixing" it by validating shape, unless
   User rules otherwise.

2. **The git position line disappears with zero explanation when
   `WORK_ROOT` is not a git repository at all** (as opposed to the
   worktree case PK-4/D-0085 already fixed, where `.git` is a file rather
   than a directory). `cmd-status.sh:275`:
   `if git -C "$WORK_ROOT" rev-parse --git-dir >/dev/null 2>&1; then say
   "commit: ..."; fi` — no `else` branch. `WORK_ROOT` falls back to `ROOT`
   when the caller's cwd is not inside a git repo (lib.sh:70-72), so the
   omission is reachable in production, not just in test sandboxes. Every
   other "could not read this" case in the same brief (P-16/`refuse_journal`)
   prints a named reason; this one is just absent. Not verified as
   deliberate — no comment addresses the no-git case, only the worktree
   case. TS-port hazard: a port that "notices" the missing else and adds a
   `commit: (not a git repository)` line has made an observable change
   without a ruling.

3. **`status --json`'s `.summary` field is always the empty string for all
   four verbs** (`emit ""` at cmd-status.sh:366,370,373,377) — consistent
   with the envelope test's requirement (`cli-shape-tests.sh:105`, `.summary
   | type == "string"`, which an empty string satisfies) but worth flagging
   as a port-visible detail: a TS implementation that "improves" this by
   synthesizing a one-line summary from `.data.lines` for report verbs
   would be an observable, unruled change to every `status --json` caller.

4. **TS-port hazard — the `grep -E '^SP-|^  T-'` filter must stay a
   per-line prefix test, not a single multiline regex match.** bash's
   `grep` operates line-by-line against `$FLIGHT`'s printed text; a naive
   JS port using `.match(/^SP-|^  T-/gm)` against the whole string is
   equivalent only if line-splitting semantics (embedded `\n` inside a
   value, e.g. the "SMUGGLED CONTINUATION" fixture at
   status-tests.sh:328-339) are reproduced exactly — the entire point of
   this filter (T-0204) is excluding a continuation line produced by a
   task title containing a literal newline. Iterating an array of lines and
   testing `startsWith` per element is the safe translation; a regex
   applied to the joined string risks the `m` flag's line-anchor semantics
   differing subtly from POSIX `grep`'s.

5. **TS-port hazard — subshell/command-substitution exit-code swallowing is
   pervasive and load-bearing in a way that is easy to under-port.**
   Almost every `jq` computation in this file (`ACTIVE`, `FLIGHT`,
   `UNFINISHED`, `RATIFIED`, `WAIT`, `PROP`, the two `J_ISSUES` passes) is
   assigned via `X=$(... | jq ...)` with **no** `|| fallback` — a runtime
   `jq` error (as in Open Question 1) leaves the shell variable as an empty
   string, which downstream numeric tests (`[ "$ACTIVE" -gt 0 ]`,
   cmd-status.sh:108) then fail *as a shell syntax error* ("integer
   expression expected") that itself gets swallowed by the `||
   return 0` immediately following it. A faithful TS port has to decide,
   per computed value, what happens on a parse/filter error — and the
   *correct* faithful behavior is "render the section's empty/default
   text, leak nothing structured, possibly print noise to stderr in human
   mode only" (see Open Question 1), which is not the obvious thing to
   write from scratch in TS (a naive `try { ... } catch { throw }` would
   turn this into a crash where bash silently continues). File:line for
   the pattern: cmd-status.sh:107-108, :116-118, :123-124, :309-310,
   :327-328.

6. **TS-port hazard — `capture_report`'s stderr-discard is per-invocation
   global state (`CLI_JSON` flips), not a parameter.** Porting this as a
   sink object passed explicitly into each report function (Simplify/perf,
   above) changes the *implementation* but must preserve the *observable*
   behavior exactly: under `--json`, nothing any report section writes to
   stderr — not `refuse_journal`'s own line (which goes through `say`,
   captured fine) but a raw tool error like the `jq: error` lines in Open
   Question 1 — reaches the caller at all. Confirmed live for `status
   sprint --json` over a malformed `sprints.json`: stderr is empty,
   `.ok:true`, `.exit:0`. cli.sh:146-156 is the mechanism; cmd-status.sh's
   four `capture_report` call sites (:365,:368,:372,:375) are what exercise
   it for this module.
