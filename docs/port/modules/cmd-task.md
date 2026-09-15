# Module inspection — `cmd-task` (`.claude/scripts/lib/cmd-task.sh`)

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

Inspected line-by-line, all 1144 lines. Cross-read against
`docs/port/PHILOSOPHY.md` (P-01…P-53), `RULINGS.md` (D-0085/D-0086),
`.claude/scripts/lib.sh` (`authority_guard`, `admission_state`,
`run_health_checks`, `ref_exists_any`, `ref_resolve`), and the behavior
corpus in `tests/scrumux-tests.sh`, `tests/error-shape-tests.sh`,
`tests/cli-shape-tests.sh`.

---

## Intent

`cmd-task.sh` is the `task` noun — the largest verb surface in the CLI by
design (`:2-13`): it absorbed five former top-level scripts plus the old
top-level `accept`/`reject` verbs, "because they were all verbs about one
thing." It dispatches through `task_run` (`:1132-1144`) to nine verbs:
`new|order|status|update` (routed through `task_impl`, `:16-260`), `lint`
(`:441-661`), `brief` (`:670-895`), `verify` (`:905-1048`), `accept`
(`:275-387`), `reject` (`:389-432`).

**The exit-code contract is a single rule applied everywhere in this file**:
0 the assertion held, 1 it did not, 2 the command could not run
(`:888-894`, restated in the help text at `:1128`; the rule is
`CLI-CONSOLIDATION.md §4`). `task lint`'s exit code is not a bespoke
count — it is `cli_fails` (`:656`), the shared tier→verdict mechanism from
`lib/cli.sh` (P-01); `task brief`'s gate failure is `emit` at exit 1, not a
"bespoke exit 2" it used to be (`:888-891`, explicit comment naming the
change).

**`task new`** (`:19-63`) requires `--title` and `--check`
(`:30-31`) with long, example-carrying refusal text — those strings are
Article-5 contract (see below). The `--issue` lane (`:37-46`, T-0113/I-0056)
gates promotion of an issue to a task on its validation verdict:
`reproduced|evidenced` passes, `invalidated`/`duplicate` refuse by name, any
other verdict (including none) refuses and names the exact remediation
(dispatch a read-only agent whose identity differs from the issue's
`.source`, run `issue validate`, then promote). `--feature`/`--story` are
existence-checked against `design.json` (`:48-49`). The new task is written
via `append_with_id` (`:56-61`) — **deliberately UNRANKED** (`:51-55`,
P-44). `ID=$NEW_ID; seal_bootstrap; emitted "$ID"` (`:62-63`) — every write
verb in this file ends `seal_bootstrap` (reseals only the file just
written, P-13) before emitting.

**`task status`** (`:64-152`) validates the status enum (`:67`), then
enforces three independent things in sequence: (1) an ACCEPTED task cannot
be moved except to `accepted` or `superseded` (`:76-79`, I-0147 — the
observed failure was a task holding `accepted=true` with
`status=in_review` simultaneously, with `records check` green); (2)
`superseded` requires `--reason` (`:85-96`, I-0059); (3) moving to
`in_progress` runs the D-0084 admission arithmetic (`:98-116`, see
`admission_state` below); (4) a hand-transition to `accepted` requires an
already-recorded `acceptance.accepted==true` (`:118-126`, D-0076 — this
path only fires for a hand-driven transition, since `task accept` sets
status itself). The write (`:127-132`) is the one place in this file that
builds a **conditional-append-of-two-different-shapes** jq program inline:
a no-op `+ ""` branch when `$why==""` that does nothing (dead code, safe to
drop in the port — see Simplify/perf). The post-write prose block
(`:135-151`) is **BEFORE `emit`** deliberately, with an explanatory comment
recording that it used to sit after `emit` (which calls `exit`) and was
therefore silently unreachable — the fix is guarded by `cli_is_json`
(`:145`, not by reading `CLI_JSON` directly, because `cli-shape-tests`
"refuses a module that reaches through the seam").

**`task order`** (`:153-216`) attaches the task order: `--scope`,
`--verify` (exactly one command), one or more `--file "path | why"`,
optional `--out`, `--ref`, `--command`, `--interface`, `--shape`,
`--artifact`, and `--light` (D-0073). Every repeatable flag is accumulated
by re-invoking `jq` once per occurrence (`:170-183`) — see Simplify/perf.
Validation: `--scope`/`--verify` required with long example-carrying text
(`:186-187`), at least one `--file` (`:188`), every file needs a `why`
(`:189-190`), `--ref` values must match a governance-id pattern
(`:194-195`), `--artifact` paths must not contain whitespace because
`session-check` matches them as space-separated words (`:196-200`, a
documented reason for what looks like an arbitrary restriction). The write
(`:201-213`) sets `.task_order` as a single object, optionally carrying
`light:true` and `expected_artifacts` only when non-empty.

**`task update`** (`:217-257`) is guarded by an **acceptance-immutability
check** (`:230-233`) not present anywhere else as a P-numbered entry: an
accepted task's title/feature/story cannot be rewritten by `update`;
the comment says "Ruled 2026-08-27: guard it, and send a genuine correction
through `repair journal`." This closed a real hole — every sibling path
(`status`, `reject`, `accept` itself) already refused an accepted task, and
`update` was "the last route around it." No D-/I- number is cited for this
ruling (see Open Questions).

**`task_accept`** (`:275-387`) is the module's densest mechanism. In order:
`acceptance_target_guard` redirects any `R-*` id to the current one
(`:269-273`, D-0076 — the old review-panel target); `require_task_ref`
resolves the id; `authority_guard` (`lib.sh:449-466`) validates the shape of
`--authority` (`direct`, `app`, `app:<session>`, or `standing:D-NNNN` whose
ref must resolve) — **it does not verify who is calling** (P-21, shared
principle, not restated as its own P-item for this call site). Write-once:
a prior `accepted:true` refuses re-acceptance (`:299-300`, I-0042) —
**note the exact jq expression** `.acceptance.accepted == true`, never
`// true`, because a *rejected* task legitimately carries
`accepted:false` and must remain acceptable. The receipt gate (`:311-317`,
CLAUDE.MD boundary 5) refuses with no receipt at all, and separately
refuses a **red** receipt (`rc!=0` or `checks_failed!=0`) naming both
numbers and the receipt's own date. Then — the re-run (`:318-358`,
P-46/I-0139): acceptance **re-executes** `task_order.verification_command`
from `$WORK_ROOT` (not `$ROOT` — CLI-7, matches `task_verify` and
`session check`) rather than trusting the stored receipt, and refuses if
there is no `verification_command` to re-run at all (a "silent skip that
reports success" was the measured failure this refusal exists to prevent,
`:331-336`). Progress text goes to **stderr**, not stdout, so it cannot
displace the machine-readable first line (`:340-342`). On success, the
write (`:360-363`) stamps `acceptance={accepted:true, by, date, authority,
reverified:true}`. The sprint-completion cascade (`:370-384`, T-0054)
checks every task in the task's ratified sprint and marks the sprint
`complete` when all are accepted — unchanged in meaning from when the
trigger lived on the (now-deleted) review record.

**`task_reject`** (`:389-432`) requires `--by` and `--reason`
(no defaults — both used to default to `'User'`, attributing acts he
never took, `:277-280`/`:390-391` comments). It refuses rejecting an
already-accepted task (`:405-406`) using `tostring` rather than `//`,
because jq's `//` treats `false` and `null` identically and the value under
test is legitimately `false` for a non-accepted task (comment at `:404`).
It reports — never blocks on — the same D-0084 admission arithmetic a
resuming task would face (`:414-424`, TELL, "recording the rejection
anyway"). The write (`:425-428`) returns the task to `in_progress` with
`acceptance={accepted:false, by, date, reason}`.

**`task_lint`** (`:441-661`) is the order validator: atomicity (D-0006) and
order-completeness (D-0005), run per task id or per `--feature`
(`:445-455`). All three severity tiers route through `lib/cli.sh`'s shared
counters (`row_fail`/`row_tell`/`row_warn`/`row_note`, `:474-476`) — the
comment records that the *old* local counters had a real bug: a finding
printed inside a `| while read` subshell incremented a counter the parent
process never saw (`:467-473`). The `--hotfix` flag (`:512`) exempts the
story-required check. The `LIGHT` lane (D-0073, `:478-492`) demotes exactly
two FAILs to TELLs — no story, and an empty `context.files` — via a shared
`lightfail()` helper; boundary 4 (acceptance check + one verification
command) is explicitly **not** demoted in either lane. Every check in the
loop (`:494-652`) is cited to its governing decision or incident in-line;
notable ones not yet in PHILOSOPHY.md are flagged NEW below. `task_lint`
also shells out to `"$SCRIPTS/scrumux" graph gov bearing --task "$TID"`
(`:616`) to cross-check governance refs against what the record actually
binds, and degrades to a TELL — never a FAIL — when the graph is
unavailable (`:617-618`).

**`task_brief`** (`:670-895`) is the read-only "full frame" for
implementing a task: title/status/story/feature/check, a rejection notice
if the task carries `acceptance.accepted===false` (`:697-712`, same `//`
hazard as reject, independently re-derived and independently commented —
worth porting as one shared helper, see Simplify/perf), the same D-0084/
D-0004 gate arithmetic reported as TELL rather than enforced
(`:714-757`), the order's scope/verify/out-of-scope, the reading list, the
governance-bearing block (`:781-806`), a code-graph "what changing these
files touches" block that calls `graph code callers`/`callees` per file,
capped at 8 files (`:839-845`) and degrading **loudly** on an unavailable
index rather than silently omitting it (`:826-828`, "silence here would
read as 'nothing calls this file', which is the most dangerous wrong
answer"), resolved-ref text via `ref_resolve` (`:868-875`), and history
from `log.json` (`:883-885`). It exits 1 (not a bespoke code) when
`HAS_ORDER != true` (`:758-762`, `:888-894`).

**`task_verify`** (`:905-1048`) runs the order's `verification_command`
plus every registered repo-health check, and writes a receipt. Its own
comment states the deliberate omission: **pass-with-stub is by design**
(`:903-904`, P-05 — a `STUB(I-XXXX)`-marked boundary is `session check`'s
to track, not this gate's to fail; nothing in this file scans for stub
markers). `write_receipt` (`:956-974`) is guarded two ways because
`task verify` runs under `readonly-sh` in read-only agent sandboxes
(D-0007): an `O_EXCL mkdir` probe against `governance/` (the same
mechanism `journal_lock` uses, chosen because a sandbox can deny the write
while `test -w` still reports the path as writable), and a subshell around
`write_json` so its `die()` on failure cannot take the whole script's exit
code with it. A failed receipt write prints to stderr and **the verdict
above stands** (P-15) — `task_accept` is where a missing/red receipt
actually bites. Repo-health results are classified PASS/TELL/TIMEOUT/FAIL
(`:1021-1027`); `TELL` (a `type=lint` check exiting non-zero, T-0144/P-04)
counts toward `CHECKS_RUN` but never `CHECKS_FAILED` — the comment records
that before this arm existed, a red lint check made `task_verify` FAIL,
which routed straight into `task_accept`'s red-receipt refusal, "exactly
the outcome T-0144 removed, undone at the one gate that reads it."

**Human-mode strings are contract.** Every `die`/`row_fail`/`row_tell`
message in this file is long-form and example-carrying by design — see the
`task new --title`/`--check` refusals (`:30-31`), `task order`'s four
refusals (`:186-190`), and the entire "WRITING THE FREE TEXT" block of
`task_usage` (`:1085-1126`), which exists specifically to teach the
*shape* of good free text by quoting real accepted examples. These are
Manifesto Article 5 text and must be ported byte-for-byte where cited as
load-bearing.

---

## Deliberate looseness

Each item: what is loose, its PHILOSOPHY.md mapping (or NEW), and its
citation in this file.

1. **A new task is left unranked.** `rank` is never manufactured at
   creation. → **P-44**. `cmd-task.sh:51-55`.

2. **`task verify` passes with a `STUB(...)`-marked boundary in place** —
   nothing in this file scans for the marker; it is `session check`'s to
   track. → **P-05**. `cmd-task.sh:903-904`.

3. **T-0144 tell-tier demotions instantiated in this file**, each a former
   block: `task brief` — task in no ratified sprint (TELL, proceeds)
   `:719-731`; `task brief` — another task in flight / at cap (TELL,
   proceeds) `:741-757`; `task lint` — verification command names a suite
   with no interpreter (TELL) `:541-543`; `task lint` — `out_of_scope`
   empty (TELL) `:552-553`; `task reject` — busy or at-cap sprint (TELL,
   rejection proceeds) `:420-424`. → **P-06**, whose own table
   (PHILOSOPHY.md Group A) names four of these five rows explicitly.

4. **A red `type=lint` health check is a TELL, not counted in
   `checks_failed`.** → **P-04**. `cmd-task.sh:1008-1027` (the local
   classification arm; the tier/order rule itself lives in `lib.sh`).

5. **`task verify`'s receipt write can fail without moving the verdict.**
   → **P-15**. `cmd-task.sh:956-974`.

6. **No `scrumux task unaccept`; acceptance is write-once and immutable.**
   `acceptance_target_guard` also redirects the pre-D-0076 `R-*` target
   name to the task. → **P-45**. `cmd-task.sh:269-273` (redirect),
   `:299-300` (write-once).

7. **Acceptance re-runs the verification command rather than trusting the
   receipt; receipt staleness is not a close blocker.** → **P-46**.
   `cmd-task.sh:275-387`, specifically `:318-358`.

8. **NEW — `task lint` downgrades an uncited governance-bearing FAIL to a
   TELL when the repo has recorded zero decisions.** A fresh deploy has an
   empty `decisions.json`; without this carve-out every first order in a
   new repo would FAIL for citing nothing, because there would be nothing
   *to* cite (I-0137 in the inline comment — not present in
   PHILOSOPHY.md). `cmd-task.sh:622-631`.

9. **NEW — `task lint`'s "scope text names an unlisted path" check is
   recall-first and TELL-only by design**, not FAIL, and not exact-match.
   It tokenizes the free-text `--scope` sentence and flags anything
   path-shaped it does not find in `context.files`/`expected_artifacts`.
   The comment states the tradeoff explicitly: "Precision matters for
   authorisation, recall matters for linting" (I-0130 in-line, not a
   PHILOSOPHY.md entry). `cmd-task.sh:592-613`.

10. **NEW — both `task lint` and `task brief` degrade a missing/unreadable
    governance-bearing graph to a TELL/loud-notice, never a FAIL.**
    `task lint`: `cmd-task.sh:616-618`. `task brief`: `:784-786`
    (governance graph) and `:826-828`/`:834-835`/`:849-851` (code graph,
    per-file, capped and self-describing on failure). This is the same
    *shape* as P-20 (a graph reader degrades rather than refusing) but
    P-20's citation is `cmd-graph.sh`'s own freshness check, not this
    file — flag as its own entry rather than folding it into P-20.

11. **NEW — the D-0073 "light" lane demotes exactly two order-completeness
    FAILs to TELL** (missing story, empty `context.files`) when
    `task_order.light == true`, and explicitly does **not** touch the
    acceptance-check/verification-command boundary. `cmd-task.sh:478-492`,
    `:511`, `:516`, `:556`, `:567`.

Not re-listed here because they are general `lib.sh`/`cli.sh` mechanisms
this file merely calls (P-01 tier→verdict, P-13 reseal-one-file, P-21
authority shape-only): cited above in Intent where they matter to this
module's behavior, not repeated as separate looseness entries.

---

## Simplify/perf

**BEHAVIOR-PRESERVING** (safe to apply in the port — same observable
output, different implementation):

- **Accumulate repeatable `task order` flags in memory, not via one `jq`
  subprocess call per occurrence.** `--out`/`--file`/`--ref`/`--command`/
  `--interface`/`--shape`/`--artifact` each re-invoke
  `jq --arg x "${2?}" '. + [$x]'` on every occurrence (`cmd-task.sh:
  170-183`) — for an order with a dozen `--file` flags that is a dozen jq
  process spawns before a single byte reaches disk. A TS port holds these
  as native arrays and serializes once. Preserve the exact per-item
  transform for `--file` (`split(" | ")` into `{path, why, expected_diff?}`,
  `:171-172`) and the whitespace/why validations that run after
  accumulation (`:188-200`).

- **Call the graph subsystem in-process, not via `"$SCRIPTS/scrumux" graph
  gov bearing`/`graph code callers`/`graph code callees` subprocess
  spawns.** `task_lint` spawns one bearing subprocess per invocation
  (`:616`); `task_brief` spawns one bearing subprocess (`:784`) plus up to
  16 more (8 files × callers/callees, capped, `:839-845`). In TS these are
  direct calls into the graph module. Preserve exactly: the
  self-heal-notice filtering (`grep -v '^graph code: rebuilt'`,
  `:855`), the UNAVAILABLE message format including `head -1` of the
  error (`:850`), and the "no `scrumux` binary at all" branch's distinct
  wording (`:834-835`) versus "unavailable index" (`:849-851`) — these are
  two different failure modes with two different messages and must stay
  two different messages.

- **Buffer repo-health evidence in memory instead of a `mktemp -d` capture
  directory.** `task_verify` writes each health check's output to
  `$CAPDIR/$NAME.out` and a `.results` TSV, then re-reads them
  (`cmd-task.sh:993-1029`). Once the check runner is an in-process TS
  function there is no cross-process boundary requiring a filesystem
  handoff. Preserve the `tail -20` bound on printed output per check
  (`:931`, `:1006`) and the exact PASS/TELL/TIMEOUT/FAIL text
  (`:1022-1026`).

- **Read the no-why context-file list directly from the parsed order
  object instead of round-tripping through `$CLI_TMP/nowhy`.**
  `cmd-task.sh:564-568` pipes a `jq` projection to a temp file, then reads
  it back line-by-line. A TS port already has the array in memory.

- **`admission_state` returns a typed value, not a TSV string parsed with
  six `cut -f` calls at three separate call sites** (`cmd-task.sh:104-109`,
  `:414-419`, `:735-740`, function itself at `lib.sh:507-527`). Same six
  values, no string round-trip. The phrased "elsewhere" sentences
  (`lib.sh:521-523`) must still be produced byte-identical, since they are
  printed verbatim in refusal and TELL text.

- **Every `write_json` call in this file** (`task new` `:56-61`,
  `status` `:127-132`, `order` `:201-213`, `update` `:245-254`,
  `accept` `:360-363`, `reject` `:425-428`, the receipt `:963-968`) goes
  through the shared journal writer, which today means a full jq
  parse/mutate/serialize/reseal per call. This is the project-wide
  "one-parse-per-journal, no subprocess jq" item from the port plan;
  cited here as this module's seven concrete instances. The dead
  `+ (if $why=="" then "" else "" end)` no-op branch in the `task status`
  write (`:130`) can simply be dropped — it adds nothing to the merged
  object under either condition.

**OBSERVABLE** (changes visible behavior — proposal only, User rules):

- **Evidence truncation is fixed at print time and also limits what a
  `--json` consumer can see.** `task_verify`'s per-check output is
  hard-bounded to the last 20 lines (`:931`, printed before the PASS/FAIL
  line); `task_brief`'s per-file caller/callee lists are bounded to 12
  lines with a "+N more" note (`:860-861`); `task_lint`'s omitted-refs
  warning caps its inline list at 8 ids (`:640-643`); `task_brief`'s
  code-graph section caps at 8 traced files total (`:842-845`). These
  bounds exist for a human terminal, not for a machine consumer reading
  `--json`, and today the same bound applies to both. Proposal: carry the
  **full** untruncated evidence in the JSON envelope's `data` payload
  alongside the truncated human-mode print, so an operator or a
  downstream tool driving `--json` is not held to a terminal-height
  heuristic. What an operator would see change: `--json` output for
  `task verify`/`task lint`/`task brief` would gain additional fields
  (e.g. full check stdout, the complete omitted-refs list, all traced
  files) it does not carry today. Not applied — this is a scope
  expansion of the JSON contract and needs a ruling, not an inference
  from "more data is obviously better" (R-V4's own repo, `scrumux-app`,
  states that preference is not a universal truth).

---

## Open questions

1. **`${2?}` required-value shell idiom bypasses this file's own die/
   die_usage contract, verified empirically.** Every flag loop in this
   file takes a value with `${2?}` (`task new` `:22-27`; `task status`
   `--reason`/`--by` `:87-89`; `task order` `:158-183`; `task update`
   `:236-239`; `task accept` `:283-284`; `task reject`'s `--by`/`--reason`
   use the same pattern at `:394-395`). When the flag is the **last**
   token on the command line (e.g. `scrumux task new --title` with
   nothing after it), `sh`'s own parameter-expansion error fires instead
   of any `die()` call. Verified directly: `sh -c 'f(){ X=${1?}; }; f'`
   prints `sh: 1: parameter null or not set` to stderr and the process
   exits **127** — not 1 or 2, the two codes this file's own contract
   documents at `:888-894`/`:1128`. PHILOSOPHY.md does not mention this
   idiom anywhere (checked: zero hits for "parameter null or not set").
   Is 127-with-a-raw-shell-diagnostic the actual, intended contract for a
   truncated flag (in which case the port reproduces exit 127 and that
   exact stderr text), or is it an unexamined rough edge nobody has hit in
   practice that the port should surface as its own numbered question
   rather than silently clean up? Either answer is fine; picking one
   without asking is the silent-tightening (or silent-loosening) this
   register exists to prevent.

   **CLOSED — User, 2026-09-01: `RULINGS.md` R-002.** It is an unexamined
   rough edge, not the contract, and the port's refusal is the ratified
   behaviour: exit **2** with the noun's own wording (`decide: --title needs
   a value — see: scrumux help decide`). Reproducing a message that names a
   bash source file BY LINE NUMBER, from TypeScript, would pin the rough edge
   as contract by accident. Closed across all **eleven** sites in the port,
   not just this file's — the shared helper is
   `src/nouns/lib/writers.ts:185`, and the count is held exact at
   `test/unit/refusal-parity.test.ts:69-70`.

   **One correction to the measurement above.** The observed exit code
   through the CLI is **1**, not 127. Re-measured 2026-09-01 against a
   deployed target: `scrumux decide new --title` prints
   `…/lib/cmd-decide.sh: line 9: 2: parameter null or not set` and exits 1;
   `task new --title` does the same at `cmd-task.sh: line 22`. The 127 in
   this entry came from `sh -c 'f(){ X=${1?}; }; f'`, which is a different
   shell invocation from a sourced module under the dispatcher. The ruling is
   unaffected — 1 is a code the contract reserves for "the assertion did not
   hold", which a truncated command line is not — but the number is corrected
   here rather than left to mislead the next reader.

2. **jq's `//` treats `false` and `null` identically; this file works
   around it twice, independently, with two separate comments.**
   `task_reject`'s already-accepted check (`cmd-task.sh:404-406`) and
   `task_brief`'s rejected-task notice (`:697-701`) both explicitly avoid
   `.acceptance.accepted // "none"` because that expression returns
   `"none"` for the `false` case it exists to catch, and both use
   `tostring` instead. TS-port hazard: JS's `??` only substitutes on
   `null`/`undefined`, which actually matches the *intended* behavior
   here better than jq's `//` did — but the two call sites must still be
   ported to the same explicit `true`/`false`/absent three-way check
   they use today (`=== true`, `=== false`, else absent), not simplified
   to `??`, or a fourth accidental encoding is added to a file that
   already independently reinvented the same fix twice.

3. **`task update`'s acceptance-immutability guard cites a date, not a
   decision or issue id.** `cmd-task.sh:221-233`: "Ruled 2026-08-27: guard
   it…" — every other refusal in this file traces to a `D-nnnn`/`I-nnnn`.
   Should the port's PHILOSOPHY-equivalent registry backfill a governance
   id for this ruling before treating it as settled, or is the inline
   comment sufficient provenance on its own? Not blocking — the behavior
   itself is unambiguous and well-reasoned — but it is the one refusal in
   this file that does not point anywhere checkable.

4. **`awk`/`sed` field-splitting on `graph gov bearing`'s text output is a
   cross-module hazard, not fully resolvable from this file alone.**
   `cmd-task.sh:620` (`awk '$1=="path" && $2=="changes" {…}'`) and `:637`
   (`sed -n 's/^\([DI]-[0-9]\{4\}\) \[changes .*/\1/p'`, POSIX ERE
   interval syntax) both depend on the exact whitespace-delimited shape
   `graph gov bearing` prints today. The TS port of `cmd-graph.sh`'s
   bearing output must be inspected before this file's two scrapers can
   be safely translated to structured access (or the port keeps them as
   string-scrapers against a TS-rendered text stream, which reproduces
   the coupling rather than removing it — a call for whoever inspects
   `cmd-graph.sh`, flagged here because this is where the coupling is
   consumed).

5. **`tr -c 'A-Za-z0-9_./-' ' '` tokenization of free-text `--scope` is
   locale-dependent in POSIX** (`cmd-task.sh:600`), and the token is then
   matched against shell glob patterns (`*/*|*.py|*.sh|*.json|*.md|*.MD`,
   `:604`) and a second glob for governance-id shapes (`:607`). JS has no
   direct `tr`-with-bracket-expression equivalent; the port needs an
   explicit character-class regex plus an explicit glob-to-regex
   translation for the suffix tests, under an assumed `C`/POSIX locale
   (consistent with the rest of the harness treating text as bytes) —
   confirm that assumption rather than inheriting the *runtime's* default
   locale, which for Node is not guaranteed to be `C`.

6. **The `printf` embedding a literal apostrophe via string concatenation**
   (`cmd-task.sh:342`: `printf 're-running %s'"'"'s verification…'`)
   prints exactly `re-running T-0001's verification before accepting: …` —
   noted so the port's string reproduces the apostrophe rather than
   dropping it or mis-escaping it during translation.
