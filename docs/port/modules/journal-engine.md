# Module inspection — journal-engine

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

**Scope.** `.claude/scripts/lib.sh` (776 lines) and
`.claude/scripts/lib/journal.sh` (219 lines). This is the write path: the
journal lock, id allocation, the five `_write_json_body` guards, the
`.backups` copy, the seal (bootstrap / per-write reseal / whole-map rebuild /
tamper compare), the derived-value cache, `ref_resolve`/`ref_journal`,
`render_views`, and the health-check runner. Every noun module (`cmd-task.sh`,
`cmd-issue.sh`, `cmd-decide.sh`, …) writes through this file; nothing else in
the CLI touches `governance/*.json` directly. This is why PHILOSOPHY.md calls
the corresponding entries "the highest-stakes" in the register — a defect
here corrupts every journal, not one noun's view of it.

Read line-by-line, both files, in full. Cross-checked against
`tests/journal-lock-tests.sh`, `tests/journal-shape-tests.sh`,
`tests/journal-cache-tests.sh`, `tests/lib-scripts-tests.sh` (§§ "T-0110",
"T-0100", "8. T-0163"), `tests/records-check-tests.sh` (§ OQ-19),
`tests/scrumux-tests.sh` (§ "T-0100 follow-up"), plus PHILOSOPHY.md (P-08
through P-20, P-44 through P-53) and RULINGS.md (D-0085, D-0086, and the
orchestrator's three closing rulings).

---

## Intent

### 1. Two roots, deliberately not one (`lib.sh:16-73`)

`SCRIPTS` (where the code lives, from `$0` via a symlink-resolving prologue
every caller runs first — `lib.sh:11-15`) is kept separate from `ROOT`/`GOV`
(where the data lives, from `GOV_ROOT` if set, else the caller's git
toplevel, else two levels up from `SCRIPTS` — `lib.sh:42-47`). A third
variable, `WORK_ROOT` (`lib.sh:70-73`), is the tree the *caller* is
physically in (its own git toplevel), independent of both.

This exists because of a measured cross-worktree failure (`lib.sh:27-41`): a
scrumux-app-dispatched session runs in a git worktree with its own copy of
`governance/`, so two concurrent sessions held two files and the O_EXCL lock
(below) on each file's own path could not see across them — SP-0001 produced
two records sharing one id in a delivery that could not be merged. Fix:
`GOV_ROOT` is pointed at the *main* checkout for every dispatched session, so
the lock and the journals are shared, while `WORK_ROOT` still resolves to the
worktree so a verification command runs against the code the session
actually wrote (`lib.sh:50-69` narrates the second-order bug this
distinction was added to prevent — pointing `ROOT` at main for both purposes
silently ran `task verify` against the wrong tree).

Port implication: this is not "resolve one project root" — it is three
independent values with three independent resolution orders, and a TS port
that collapses `WORK_ROOT` into `ROOT` reproduces exactly the bug `lib.sh:50-69`
documents fixing.

### 2. `read_journal` — a tri-state read (`lib.sh:101-138`)

Three outcomes: **absent** (print the default, `{"entries":[]}`, rc 0),
**parses** (print the file, rc 0), **present-but-unreadable** (print
*nothing*, rc non-zero). It never calls `die` — the header states callers
must dispose of the same fact differently, and PHILOSOPHY.md P-16 documents
that this is true for exactly three live call sites, all in `cmd-status.sh`.
`cmd-backlog.sh` does not call it at all — it hand-rolls the same
`jq -e . … || die` check three times, and that `die` is `lib/cli.sh`'s (exit
2), not the exit 1 an earlier version of this file's own comment claimed.
The comment at `lib.sh:123-130` has since been corrected in place to say so;
this is worth citing because it is a concrete instance of "the comment was
wrong, the code was right" in the same file the port is reading for
authority.

Verified in `tests/lib-scripts-tests.sh:247-300` (§8): absent → `rc=0
out={"entries":[]}`, caller-supplied default wins for absent, unreadable →
`rc=1 out=` (literally nothing on stdout), and it "must never die" is
asserted directly by running it against a corrupt file with `|| :` and
checking the shell survives.

### 3. The lock (`lib.sh:150-179`, plus every guarded write below)

`journal_lock` is an O_EXCL `mkdir "$f.lock"` spin-loop —
`JOURNAL_LOCK_TRIES` (default 100) attempts, `sleep 0.1` (falls back to
`sleep 1` if the shell's `sleep` doesn't take a fraction) between attempts,
then `die` naming the exact lock directory and the manual clear command
(`rmdir '<path>.lock'`). `journal_unlock` is `rmdir "$f.lock" 2>/dev/null ||
:` — never fails, never blocks a caller from unlocking something that is
already gone.

Deliberately `mkdir`, not `flock(1)` — the comment (`lib.sh:160-163`) states
`flock` is a util-linux program absent on the declared platform (darwin),
while `mkdir` is atomic on every POSIX filesystem with no helper binary
needed.

**Not re-entrant.** The comment at `lib.sh:167-169` states this explicitly:
"Never call twice for the same file without unlocking... the locked helpers
below share one unlocked body rather than nesting." This is why
`_write_json_body` (the guarded write) is a *separate, private* function from
`write_json` (lock + body + unlock) and `append_with_id` (lock + allocate +
body + unlock) — both callers take the lock themselves and call the same
unlocked body, rather than `append_with_id` calling `write_json` and double-
locking.

Verified in `tests/journal-lock-tests.sh`: two concurrent `scrumux task new`
five times over (§1, mirroring the measured 5/5 reproduction I-0079 got),
plus a second allocator (`scrumux issue new`, §2, "the bug was never
task-only"), plus "the lock is always released" (§3, no `*.lock` directory
survives a clean run) and "a stale lock fails loudly and names how to clear
it" (§4, asserts the message contains the literal lock path).

### 4. `next_id` — max+1 over a live stream, not a counter (`lib.sh:607-611`)

```sh
next_id() {
  jq -r --arg p "$3-" '['"$2"' | select(. != null) | ltrimstr($p) | tonumber] | (max // 0) + 1' "$1" \
    | { read -r n || n=1; printf '%s-%04d' "$3" "$n"; }
}
```

No id counter is stored anywhere; every allocation re-derives max+1 from the
journal's current id stream, formatted `<prefix>-%04d`. This is why it *must*
run inside the same lock as the write — `append_with_id`
(`lib.sh:313-319`) takes the lock, computes `NEW_ID` via `next_id`, then
calls `_write_json_body` with `--arg id "$NEW_ID"` under the same holder,
closing exactly the race `journal-lock-tests.sh` exercises: id allocation
outside the lock is the CLI-14 duplicate-id bug class (named at
`TS-MIGRATION-HANDOFF.md:51` and cross-referenced at PHILOSOPHY.md:1651).

### 5. The five `_write_json_body` guards, in order (`lib.sh:184-294`)

All under the caller's lock, no locking of its own:

1. **jq exit status** (`:187`) — non-zero jq → `rm -f "$tmp"`, unlock, `die`.
2. **non-empty temp file** (`:200`) — `[ -s "$tmp" ]`. Guards a filter that
   exits 0 but emits nothing (a `select(...)` matching nothing), which
   otherwise truncates the journal to zero bytes at rc 0. Comment cites a
   measured incident: 237164 bytes → 0, rc 0, success line printed.
3. **object-with-entries-array shape** (`:209-213`) — `type == "object" and
   has("entries") and (.entries | type == "array")`. The comment records
   this used to be `type == object` only, because two of eleven journals
   (`health-review.json` = `{reviews}`, `repo-health.json` = `{checks}`)
   were not entries-shaped; both were migrated (T-0157/I-0035) so the
   stronger guard could ship.
4. **entry-count non-reduction** (`:228-235`) — counts `.entries | length`
   before and after; if `after < before` and `ALLOW_ENTRY_REMOVAL` is not
   literally `"1"`, refuse with a message naming both counts. Motivated by a
   measured incident (`:218-222`): a repair filter using `($stream) as $x |
   body` over an *empty* stream dropped every non-matching entry —
   `decisions.json` went from 80 to 6, silently, reported as success,
   because a valid 6-entry array passes every guard above it.
5. **the `.backups` copy** (`:264-282`) — `mkdir -p "$GOV/.backups"` (best
   effort), a self-ignoring `.gitignore` written into it (best effort, and
   the comment explains *why* it must self-ignore: `deliver` refuses a
   dirty tree, so an untracked backup file could block the very session
   that wrote it — observed on T-0006), `cp -p` of the *pre-write* file
   (best effort), then prune to the newest `JOURNAL_BACKUPS` (default 10)
   generations via `ls -t | tail -n +N+1 | rm` (best effort per file).
   `JOURNAL_BACKUPS=10` is deliberately more than one: the comment
   (`:254-263`) states "restoring is not always take the newest" — some
   verbs write a journal twice in succession (repair rewrites the target,
   then appends its own log entry to `log.json`), so the newest backup of a
   damaged journal can postdate the damage.

Then: `mv "$tmp" "$f"` (the atomic swap — die on failure, still under lock),
then `reseal_one "$f"` (§7 below) as the body's last statement, so the
body's own return status *is* whatever `reseal_one` returns.

Verified: `tests/journal-shape-tests.sh` (§3: a filter producing
`{other:.entries}` is refused, and the refusal fires *before* `mv` — the
original file is unmodified after the refusal); `tests/lib-scripts-tests.sh`
"T-0110/I-0058" section (§, lines 95-142): empty-result refusal, non-object
refusal, ordinary write still succeeds, and a `{checks}`-shaped journal is
still writable (proves the guard is `has("entries")`, not "every top-level
key must be `entries`"). The entry-count guard itself has **no direct test**
in any suite grepped for `ALLOW_ENTRY_REMOVAL` — see Open Questions.

### 6. `write_json` vs `append_with_id` (`lib.sh:296-319`)

`write_json` = lock, body, unlock — for any journal mutation with no new id.
`append_with_id` = lock, `next_id`, body (with `--arg id "$NEW_ID"` forced
onto the filter's argv, ahead of caller-supplied args), unlock — for a new
record. The comment at `:311-312` is explicit that callers "must NOT pass
their own `--arg id`" — the id is the function's to inject, not the
caller's to supply, because supplying it outside the lock is exactly the
race this function exists to close.

### 7. `reseal_one` — resealing only the file just written (`lib.sh:321-366`)

After every guarded write, `_write_json_body` calls `reseal_one "$f"` on
*only the file it wrote* — never `seal_journals` (which rebuilds the whole
map). The comment (`journal.sh:134-140`) explains why this is deliberate and
not an optimization shortcut: `seal_journals` used to run on every write and
*silently defeated the seal* — any unrelated `scrumux` command re-sealed a
hand-edited journal as if scrumux had written it, erasing the tamper
evidence. Measured: a tampered `tasks.json` was reported by
`records check`, then one `scrumux decide` (touching `decisions.json`) made
the report disappear.

`reseal_one` is a no-op (return 0) for a file outside `SEALED_JOURNALS`
(`:327`) or before the repo has ever been sealed (`:329`, `[ -f "$_seals" ]
|| return 0`). Otherwise it takes the journal lock *on `seals.json` itself*
(`:334`) — **lock order is journal-then-seals, never the reverse**
(`:322-324` states this explicitly; `seals.json` is the single most
contended object in the system because every journal write touches it) —
computes the new hash, and does a `jq … > tmp && [ -s tmp ] && mv` that also
*prunes* any key in the map not in the current `SEALED_JOURNALS` list
(`:349-352`, the `with_entries(select(...))` filter). The prune half exists
for the same reason `SEALED_JOURNALS` is a literal list and not a glob (§8
below): a seal written by an older harness for a file the current list
excludes would otherwise survive forever and permanently fail `records
check` on an otherwise-clean deploy (measured against scrumux-agents,
`lib.sh:340-348`).

On failure (`_rs_failed=1`), it prints a named stderr message — "could not
update the seal for X — the next records check will report it as changed
outside scrumux, wrongly" — and `return 1`. **This status does not reach
any caller.** `reseal_one` is the last statement of `_write_json_body`, so
its status becomes the body's status — but `write_json` (`:300-304`) ends
with `journal_unlock`, which is `rmdir … || :`, always 0. So the `return 1`
is swallowed one frame up; only the stderr line survives, and under
`--json` that line is unstructured while stdout carries the one success
object (PHILOSOPHY.md P-13, OQ-18).

### 8. `SEALED_JOURNALS` is a literal list, not a glob (`lib.sh:377-383`)

```sh
SEALED_JOURNALS="design.json tasks.json sprints.json decisions.json issues.json exceptions.json log.json repo-health.json"
```

Eight names, hardcoded. `code-graph.json` and `governance-graph.json` (both
derived/rebuilt by their own commands) and `seals.json` itself are
deliberately absent — sealing a derived file breaks on every rebuild
(P-22). A glob (`readdirSync(gov).filter(f => f.endsWith('.json'))`) is the
literal regression this list exists to prevent.

### 9. `seal_journals` — whole-map rebuild, called exactly once in practice (`lib.sh:391-406`)

Hand-rolled `printf` + `jq`-per-file loop building the entire
`{sealed_at, journals: {...}}` object from scratch, skipping any listed
journal not present on disk (`:399`, `[ -f "$GOV/$_n" ] || continue`) — this
skip is *why* an incomplete map is the natural steady state (§11 below).
Bypasses `_write_json_body` entirely — no shape guard (this file has no
`entries` array — P-50), no entry-count guard, no `.backups` copy. It takes
no lock of its own at the top level; its two callers (`seal_bootstrap`,
directly, and nothing else in the live tree) are the ones responsible for
locking if concurrency matters at that call site — in practice
`seal_bootstrap` runs once, at first-ever write, before contention is
plausible.

### 10. `seal_bootstrap` — create the baseline, and say so if it laundered something (`journal.sh:149-179`)

Called from every `render_views` (`journal.sh:125`), no-ops if
`seals.json` already exists (`:150`). Otherwise: scan every `governance/*.json`
except the seal file itself for any journal with a non-empty `.entries`
array (`:167-172`); call `seal_journals` unconditionally to create the
baseline; and **if** content was found, stamp
`bootstrapped_over_existing_content: <date>` into the freshly-created file
(`:174-178`, itself a hand-rolled `jq … > tmp && [ -s tmp ] && mv` with
`rm -f "$tmp"` on failure — no guarded writer, no lock).

The comment (`:151-166`) is explicit that this is the deliberate answer to a
real laundering vector: deleting `seals.json` and making any write rebuilds
the whole map from whatever the journals contain *right now*, sealing in any
hand edit made before it as though scrumux had written it. The fix is not to
refuse the bootstrap — "a repo that predates sealing has to be able to
start" — but to *record* the fact rather than print it, because a stderr
warning is ephemeral and was measured splicing into an unrelated refusal
message (records-sweep-tests). A flag in `seals.json` survives and
`records check` reads it.

### 11. `broken_seals` compares only journals with a recorded key (`lib.sh:547-555`)

Iterates `.journals | to_entries[]` from `seals.json` — **driven by the seal
map, not by `SEALED_JOURNALS`**. A journal that is in `SEALED_JOURNALS`,
present on disk, but has no entry in the map (because `seal_journals` skipped
it at bootstrap for not existing yet, and nothing has added it since) is
never hashed and never reported — invisible to tamper detection, not flagged
as unsealed (P-52). This repo is measured to be in that state today
(`exceptions.json` present, `SEALED_JOURNALS`-listed, absent from the current
seven-key map). `seals_shape_problem` (`lib.sh:529-545`) catches three
distinct degenerate shapes — file doesn't parse, `.journals` isn't an object,
`.journals` has zero keys — and returns 0 (never fails) in every case,
printing a sentence naming the consequence ("so nothing is being checked")
rather than failing. It does **not** catch an *incomplete* map, which is the
naturally-occurring case, not a corruption case.

`records-check-tests.sh:306-323` (§ "OQ-19") shows this gap was ruled on and
partially closed **in `cmd-records.sh`** (a different module, not this one):
`records check --structure` now names a sealed-listed, on-disk,
map-absent journal. `broken_seals` itself (this module) is unchanged —
the fix is a report built on top of it, not a change to its iteration.

### 12. The derived-value cache (`lib.sh:578-605`)

`governance/.cache/`, keyed by `cache_key <label> <journal-path>...` which
concatenates the label with `:<live-sha256-of-each-file>` (or `:absent`) and
hashes the whole string. **Deliberately not read out of `seals.json`** — the
comment (`:561-565`) states a journal edited outside scrumux would keep
serving a stale answer if the key came from the seal map, since the seal
only moves on a scrumux write. `cache_get` returns 1 (fall through to full
computation) for absent, empty, or unreadable — never partial or wrong data.
`cache_put` is unconditionally non-fatal: an unwritable cache dir drains
stdin and returns 0. The whole directory is disposable — outside the
`governance/*.json` glob every sweep walks, gitignored, not in
`SEALED_JOURNALS`.

Verified in `tests/journal-cache-tests.sh`: warm read byte-identical to
cold (§1), the cache is actually exercised — not two cold runs by accident
(§2), any journal edit invalidates including one scrumux never made (§3,
the whole reason for hashing live), removing the directory doesn't break the
reader (§4), a corrupt cache entry falls through rather than poisoning (§5),
and the cache is confirmed absent from both `SEALED_JOURNALS` and present in
`.gitignore` (§6).

### 13. `render_views` — views regenerate on demand, not on every write (`journal.sh:29-126`)

Regenerates `AI_LOG.MD`, `DECISIONS.MD`, `BACKLOG.MD` (all pure jq
projections over the corresponding journal, printed with a "GENERATED VIEW —
do not edit by hand" banner) and the governance graph
(`scrumux graph gov build`, invoked as a subprocess of itself). T-0187 took
this off every write path (D-0076) because it cost ~0.15s of a ~0.19s write
on views nobody reads mid-session; it now runs only on explicit
`scrumux views render` and at session close.

Graph build failure here is **non-fatal**: sets `GRAPH_BUILD_FAILED=1`,
prints a stderr warning, and the caller (`render_views` itself) proceeds —
this is deliberately different from `scrumux views render`'s own explicit-
request path (`cmd-views.sh`), which treats the same failure as fatal
(`row_fail`, non-zero exit). PHILOSOPHY.md P-14 names this the intended
asymmetry: an implicit rebuild inside a write transaction must not abort it;
an explicit request for a view must not silently report success it did not
achieve. `mkdir -p "$GOV"` before the graph build (`:115`) is itself a fix
for a measured defect — the graph writer does not create its own output
directory, so `views render` on a repo with zero prior gov writes died with
a Python traceback.

`render_views` ends by calling `seal_bootstrap` (`:125`) — the "half of the
old `render_views` tail that is a write concern rather than a view one"
(comment, `:142-148`).

### 14. `authority_guard`, `parallel_guard`, `admission_state` (`lib.sh:449-527`)

Shared plumbing for two reserved-act mechanisms, not journal I/O per se, but
co-located here because both are consumed by writer nouns under the same
lock discipline:

- `authority_guard` validates the *shape* of an `--authority` value —
  `direct`, `app`, `app:<session>`, or `standing:D-NNNN` where the decision
  must resolve in `decisions.json` — and explicitly does **not** check who
  is calling (`:446-448`, verbatim in the source). This is Article 4 (a
  check claims only what it computes) applied to identity.
- `parallel_guard` validates `--parallel` is a positive integer, never
  coerces.
- `admission_state` computes, in one jq pass, the D-0084 parallel-dispatch
  arithmetic (a task's ratified-sprint home, that sprint's declared cap,
  same-sprint busy count, and an "elsewhere" list phrased for a message) so
  four call sites (writer, brief gate, reject TELL, records validator) share
  one computation rather than four chances to disagree.

### 15. `run_health_checks` (`lib.sh:696-775`)

Not journal I/O, but shares this file because it is the other place a
noun-agnostic execution primitive lives. Registered checks (from
`repo-health.json`, itself a `SEALED_JOURNALS` member written through the
normal guarded path) run **concurrently in bounded batches** (POSIX sh, no
arrays — each worker writes one result file named by its registry index;
default `HARNESS_HEALTH_JOBS=8`), then **collate in registry order** so
output is deterministic regardless of finish order (load-bearing: a receipt
log carries this verbatim). `HARNESS_IN_HEALTH_CHECKS=1` is exported once
here rather than by each caller, closing a recursion-guard gap where one
caller set the marker and another didn't (T-0135). Verdict/tier logic —
`TIMEOUT` (rc 142) outranks the `lint`-type TELL carve-out, tested in that
order — is covered under Deliberate looseness (P-04) since it is squarely a
looseness, not a mechanism.

---

## Deliberate looseness

Each item: what is loose, whether PHILOSOPHY.md already registers it
(item #) or not (NEW).

1. **A failed `.backups` copy never refuses the write it is protecting.**
   `mkdir -p`, the self-ignoring `.gitignore`, `cp -p`, and the pruning
   `rm -f` are all best-effort (`|| :` or `2>/dev/null`). — **P-09**.
2. **`seal_bootstrap` launders pre-existing content into the baseline
   without refusing.** Deleting `seals.json` and writing anything rebuilds
   the whole map from current content, silently certifying any prior hand
   edit. Answered with a recorded flag (`bootstrapped_over_existing_content`),
   never a refusal or even a stderr warning. — **P-12**.
3. **`reseal_one` never calls `seal_journals`** — reseals only the file just
   written. Looks collapsible; collapsing it defeats tamper detection
   entirely (measured: one `scrumux decide` erased an unrelated tamper
   report). — **P-13**.
4. **`reseal_one`'s failure `return 1` never reaches any caller** —
   swallowed by `journal_unlock`'s unconditional `rmdir … || :` return 0.
   Only a stderr line survives, invisible under `--json`. — **P-13 / OQ-18**.
5. **A graph build failure inside `render_views` is non-fatal**; the same
   failure through `scrumux views render` is fatal. Same condition, two
   dispositions, both deliberate. — **P-14**.
6. **`read_journal` never calls `die`; absence and parse-failure are two
   different non-fatal outcomes**, left to the caller to dispose of
   differently. — **P-16**.
7. **`broken_seals` is silent when `seals.json` is entirely absent** — an
   unsealed repo is not reported as tampered — and **silently skips any
   sealed-listed journal that has gone missing from disk**, rather than
   reporting it. — **P-17**.
8. **`seals_shape_problem` always returns 0**, including when it found a
   real problem; a caller distinguishes "found something" from "clean" by
   whether the returned *string* is empty, never by exit code. — **P-18**.
9. **`SEALED_JOURNALS` is a fixed eight-name list, not a glob** — a derived
   file (either graph index) or a future journal not on the list is
   permanently unsealed, on purpose. — **P-22**.
10. **`seals.json` itself bypasses every `_write_json_body` guard** — no
    shape check (it has no `entries` array, would fail the guard outright),
    no entry-count guard, no `.backups` copy. All three of its writers
    (`reseal_one`, `seal_journals`, `seal_bootstrap`'s flag stamp) are
    hand-rolled `jq > tmp && mv`. It does take the journal lock. — **P-50**.
11. **`broken_seals` compares only journals with a recorded key in the seal
    map** — a `SEALED_JOURNALS` member present on disk but absent from
    `seals.json` (the natural post-bootstrap state for any journal that
    didn't exist yet) is invisible to tamper detection, not flagged as
    unsealed. — **P-52**.
12. **The derived-value cache never fails anything** — `cache_get` returns 1
    (miss) for absent/empty/corrupt, `cache_put` is unconditionally
    non-fatal, and the whole directory is disposable. — **P-11**.
13. **`run_health_checks` returns 0 (success, having run nothing) when
    `repo-health.json` doesn't exist.** — **P-19**.
14. **A red `lint`-typed health check is reported `TELL`, never counted as a
    failure; only a `test`-typed check turns the run red** — and the branch
    order (`rc==0`, then `type==lint`, then `rc==142`) means a `lint` check
    that **times out** is *also* reported TELL and not counted, which is a
    narrower carve-out than the T-0144 reasoning (protecting a linter's
    *findings*) actually covers, since a timed-out linter produced no
    findings. — **P-04** (the base looseness is registered; the timeout
    interaction was ruled in D-0085/OQ-15 and FIXED in Phase 1a — `lib.sh:767`
    counts rc 142 as TIMEOUT/failure *before* the lint branch, asserted by
    `tests/health-runner-tests.sh:146-158` — so the "also reported TELL"
    reading above describes pre-1a behavior only).
15. **A seeded/never-written journal is not byte-identical to `jq .` output**
    (`ensure_file` writes a literal `{"entries": []}` template via `printf`,
    16 bytes, vs. jq's pretty-printed 22 bytes) — and stays that way until
    its first real write. Confirmed against this repo:
    `governance/exceptions.json` is the one journal here still in that
    state. `ensure_file` **does** `die` on a failed `mkdir`/write, unlike
    every best-effort write above it — the one place in this module where a
    filesystem failure is fatal. — **P-49**. (`ensure_file` itself lives in
    `lib.sh`; the template constant lives with each caller.)
16. **`authority_guard` validates only the shape of `--authority`, never who
    is calling** — no identity check, no caller allowlist, stated explicitly
    in the source comment as deliberate. — **P-21**.
17. **`next_id` silently defaults to `1` when a journal contains an id whose
    numeric suffix doesn't parse** (`jq: error … tonumber` on e.g. `T-000A`
    makes the pipe empty, `read -r n || n=1` defaults, and the allocator
    hands out an id that likely already exists, at rc 0 — jq's stderr goes
    nowhere inspected). Not a registered PHILOSOPHY.md item — this is
    **OQ-7**, explicitly *not fixed* in bash, and carries a named
    **APPROVED-DIVERGENCE** for the TS port: RULINGS.md D-0085 states the TS
    `nextId` **refuses** a malformed id instead of allocating a duplicate at
    rc 0. This is the one place in this module where the port is ruled to be
    *stricter* than bash, on the record, rather than reproducing the bash
    behavior. Cite `// APPROVED-DIVERGENCE: D-0085` at the port site.
18. **`admission_state`'s cap defaults to 1 when a task is in no ratified
    sprint** — the pre-D-0084 rule (`lib.sh:504-506`, stated as unchanged for
    exactly that case) rather than a fallthrough that admits unboundedly. Not
    separately registered in PHILOSOPHY.md; flagged **NEW** here as a
    looseness worth naming (a repo-global cap of 1 applying only outside a
    ratified sprint, silently) though it reads as intended design rather
    than an accident — no comment marks it suspicious.
19. **`journal_unlock` never fails** (`rmdir … 2>/dev/null || :`) — even
    called on a lock directory it does not hold, or one already gone. This
    is what makes item 4 above possible (a real failure upstream is masked
    by an unlock that always succeeds). Not separately registered; flagged
    **NEW** as the general mechanism behind P-13's `return 1`-swallowing,
    since a TS port reaching for "clean up in a `finally`" will reproduce
    the swallow unless it explicitly propagates the body's own status
    first.

---

## Simplify/perf

**BEHAVIOR-PRESERVING:**

- **One parse per journal per write**, not one-per-guard. Today's
  `_write_json_body` calls `jq` up to four times against the same files in
  one `write_json` call: the filter itself, the shape guard
  (`jq -e 'type == "object" …'`), the before-count (`jq '.entries | length'
  "$f"`), the after-count (same, on `"$tmp"`) — plus `seal_of` (a `shasum`
  subprocess) inside `reseal_one` right after. A TS port holding the parsed
  document in memory can run the filter once and derive shape/counts from
  the in-memory result, then hash the serialized bytes once for the seal.
  Explicitly sanctioned: PHILOSOPHY.md's closing section names "one parse
  per journal" as approved behavior-preserving work.
- **No subprocess `jq`/`shasum`/`awk`.** Every call above is a forked
  process today (`jq`, `shasum -a 256 | awk '{print $1}'` in `seal_of`).
  In-process JSON parse/serialize and a Node `crypto.createHash('sha256')`
  are pure wins with no behavior change, *provided* the serializer
  reproduces `jq .` byte-for-byte (Spike A: confirmed for all 11 live
  journals and 53/54 adversarial cases; the one gap — a lone surrogate
  escape jq refuses and JS accepts — is OQ-9, not this module's call to make
  silently).
- **The conf/registry equivalent here — `SEALED_JOURNALS` — compiled/held
  once per process**, not re-parsed. It is already a static shell string in
  bash; in TS this is just "a constant array", trivially preserved.
- **`next_id`'s stream scan** — currently a full `jq` pass over every id in
  the journal on every allocation. In-memory, this is a single `.map/.filter`
  over an already-parsed array; behavior-preserving as long as the
  malformed-id case is handled per the approved divergence (item 17 above),
  not silently "fixed" to skip-and-continue, which would produce a different
  max than bash's `tonumber` crash-to-default-1 behavior in the case bash
  itself has never hit live.
- **`run_health_checks`'s bounded-concurrency batching** — the POSIX-sh
  workaround (temp-file-per-index, `wait` every `HARNESS_HEALTH_JOBS`) exists
  only because POSIX sh has no real concurrency primitive. A TS port using
  `Promise.all` with a concurrency limiter reproduces the same *behavior*
  (bounded parallelism, deterministic index-ordered collation) with less
  code — the collation-by-registry-index requirement is the behavior to
  preserve; the file-per-worker mechanism is not.

**OBSERVABLE (proposal only — User rules):**

- **P-13/OQ-18: make `reseal_one`'s failure reach the write's caller**,
  e.g. as a warn row in the response envelope, rather than only a stderr
  line invisible under `--json`. RULINGS.md D-0085 already lists this as an
  **approved TS divergence**: "a failed reseal adds a warn row to the
  envelope, exit code unchanged." *What an operator would see change:* a
  `--json` caller that could not previously tell a reseal failed from a
  clean write now sees a `warnings: [...]` entry naming the file; the human-
  mode stderr line is unchanged; the write's own exit code and success
  reporting are unchanged (the write itself still succeeded).
- **P-52/OQ-19: promote "sealed-listed journal absent from the seal map" from
  invisible to a `records check` warning** — this is *already ruled and
  landed* in `cmd-records.sh` (a different module) per D-0085's Phase 1a
  item "OQ-19: `records check` WARNs on a sealed-listed journal absent from
  the map," confirmed live by `tests/records-check-tests.sh:306-323`.
  Nothing to propose here — noted so a reader of this module doesn't
  re-propose it as new. `broken_seals` itself (this module) is unchanged.
- **OQ-15 — RULED and already fixed (correction, validation pass
  2026-08-31).** D-0085 ruled a TIMEOUT outranks the `type=lint`
  carve-out, and the fix landed in Phase 1a: `lib.sh:767` counts rc 142
  as a failure before the lint branch, asserted by
  `tests/health-runner-tests.sh:146-158`. This bullet originally flagged
  the question for User; it is not open.

---

## Open questions

1. **`next_id`'s malformed-id crash-to-1 path has no direct bash test.**
   (`lib.sh:607-611`) Confirmed manually by PHILOSOPHY.md's validator
   (OQ-7), not by any suite in `tests/`. The TS port implements the
   *approved divergence* (refuse, per D-0085) rather than reproducing this,
   so parity here is against the ruling, not against bash's actual crash-
   default-1 behavior — worth flagging so the port's differential harness is
   told to *expect* a mismatch at this one site rather than treat it as a
   regression to chase down.
2. **The entry-count-reduction guard (`ALLOW_ENTRY_REMOVAL`,
   `lib.sh:228-235`) has no direct test in any suite grepped** (`tests/
   *ALLOW_ENTRY_REMOVAL*` returns nothing). `journal-shape-tests.sh` and the
   "T-0110/I-0058" section of `lib-scripts-tests.sh` test the other four
   guards explicitly; this one — arguably the highest-consequence guard,
   since it is the one motivated by an actual data-loss incident
   (decisions.json 80→6) — is exercised nowhere in the corpus this
   inspection found. Not a bash defect (the guard demonstrably works, per
   its own comment's incident writeup), but a **coverage gap the port should
   not inherit silently**: a TS test asserting this guard fires (and that
   `ALLOW_ENTRY_REMOVAL=1` lets a real reduction through) does not yet exist
   in bash to port from, and should be written fresh rather than assumed
   covered.
3. **`admission_state`'s cap-of-1-outside-a-ratified-sprint default**
   (`lib.sh:504-506`, looseness item 18 above) — no comment marks this as a
   deliberately suspicious edge, but no ruling explicitly blesses it either;
   it reads as the stated, intended continuation of D-0006's original
   repo-global rule for exactly the case D-0084 doesn't cover. Recorded here
   as read-and-accepted rather than an open question needing User, but
   flagged because it is the kind of "looks obviously right" reasoning
   PHILOSOPHY.md's own methodology (P-02, P-16) warns against trusting
   without running — this inspection did not construct a probe for it, and
   a differential-harness case exercising a task with no ratified-sprint
   home alongside busy tasks elsewhere would close the gap.
4. **TS-port hazard — `seal_of`'s hash must be computed over the exact bytes
   `_write_json_body` writes, not a re-serialization.** (`lib.sh:385`,
   `seal_of() { shasum -a 256 "$1" | awk '{print $1}'; }`) Bash always hashes
   the file *on disk* after the `mv`. A TS port that hashes an in-memory
   string and then separately writes that string is fine only if the two are
   guaranteed byte-identical (true today per Spike A) — but if the write
   path and the hash path ever diverge (e.g. a future BOM, line-ending, or
   trailing-newline difference introduced by a serializer change), the seal
   would silently certify bytes different from what's on disk. Not a
   question needing a ruling — a implementation-discipline note: **hash the
   bytes actually written, from the same write, not a recomputed
   serialization.**
5. **TS-port hazard — lock timing under `sleep 0.1`.** (`lib.sh:175`,
   `sleep 0.1 2>/dev/null || sleep 1`) POSIX `sleep` on some platforms only
   takes integer seconds, so the fractional sleep silently falls back to a
   10x-longer wait per retry on those platforms — meaning `JOURNAL_LOCK_TRIES
   ×` wall-clock time before the stale-lock `die` fires is *itself platform-
   dependent* in bash. A TS port using `setTimeout` doesn't inherit this
   variance (it can always honor 100ms), which changes observed timing
   behavior (faster failure on platforms where bash was slow) without
   changing the *contract* (still dies after `JOURNAL_LOCK_TRIES` attempts,
   still names the lock path). Flagging because "how long does a stale-lock
   `die` take to fire" is the kind of thing a test timeout could
   accidentally encode as a requirement if ported carelessly — the number of
   *tries*, not the wall-clock duration, is the actual contract per
   `journal-lock-tests.sh:86` (`JOURNAL_LOCK_TRIES=2` is what the test
   pins, not a duration).
6. **TS-port hazard — `next_id`'s prefix-strip is a literal string prefix,
   not a pattern.** (`lib.sh:609`, `--arg p "$3-"` then `ltrimstr($p)`) A
   prefix like `T` strips exactly `T-`; an id from a *different* prefix
   family sharing a substring (there are none today, since every prefix is
   single-letter-or-`SF`/two-letter and journals are single-prefix, but
   `design.json` is polymorphic — epics/features/stories/surfaces/controls
   share one file, `SF-`/`S-`/`F-`/`E-`/`C-` per OQ-3) means a TS port must
   filter the id stream to the *same* records bash's caller-supplied jq
   filter (`$2`, e.g. `.entries[].id`) already filters to, not assume
   `next_id` itself discriminates by kind. `next_id` trusts its caller's
   stream expression entirely — worth stating because a TS rewrite that
   "helpfully" adds kind-filtering inside a generic `nextId` helper would
   silently change behavior for a caller that intentionally passed an
   unfiltered stream.
7. **TS-port hazard — `_write_json_body`'s temp-file name includes `$$`
   (the shell PID), not a random/UUID suffix.** (`lib.sh:186`,
   `tmp="$f.tmp.$$"`) Collision-free under bash because each process has a
   unique PID for its lifetime and the lock already serializes writers to
   the same file. A TS port (single Node process, not fork-per-invocation)
   has no equivalent "PID changes every write" property if multiple writes
   happen within one long-lived process — a temp-name scheme needs a
   different uniqueness source (e.g. a counter or random suffix) to avoid
   two in-flight writes to *different* journals colliding on directory
   listing patterns like `"$_bk/$_bkbase."*` used by the backup pruner
   (`lib.sh:279`), which globs by *name*, not by lock ownership.
8. **`seal_bootstrap`'s content scan globs `"$GOV"/*.json`** (`journal.sh:168`),
   which is a *different* enumeration than `SEALED_JOURNALS` — it walks
   every JSON file in `governance/`, not just the eight sealed ones, when
   deciding whether "content to launder" exists. So a derived file
   (`code-graph.json`) with entries would trip the
   `bootstrapped_over_existing_content` flag even though that file is never
   itself sealed. Not verified as deliberate or accidental — no comment
   addresses whether the scan should be scoped to `SEALED_JOURNALS` instead
   of the full glob. Flagging as an open question rather than porting a
   silent "fix" either way.
