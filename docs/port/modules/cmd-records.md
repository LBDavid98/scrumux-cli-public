# Module inspection — `cmd-records`

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

**Source:** `.claude/scripts/lib/cmd-records.sh` (690 lines, one exported
verb: `records check`).
**Tests read in full:** `tests/records-check-tests.sh` (330 lines),
`tests/records-sweep-tests.sh` (253 lines, §9a/§9b portion — the same
`records check` binary, exercised from a different fixture angle).
**Read alongside:** `docs/port/PHILOSOPHY.md` P-07, P-17, P-18, P-22, P-34,
P-35, P-52, OQ-2, OQ-3, OQ-19 (all module-specific); `RULINGS.md`
D-0085 (OQ-19 ruled in, OQ-2 wired in bash already).

---

## Intent

`cmd-records.sh` is **the repo validator** (`.claude/scripts/lib/cmd-records.sh:5`,
citing T-0140 and D-0002/D-0003/D-0012). It is the fusion of three checkers
that used to drift independently — journal structure/cross-refs/rules-chain/
doc-rosters/seals ("governance-validate"), JSON-Schema contract checking
("schema-check", delegated to `agents/lib/schema_check.py`, never
reimplemented in jq — `:11-13`, D-0010), and a mechanical code-standards
sweep ("check-standards", now deliberately empty — see Deliberate looseness
below). The whole module is one function, `records_check()` (`:16-656`),
dispatching to `sweep_structure()` (`:131-616`) and `sweep_standards()`
(`:620-636`) by `--structure`/`--standards`/`--all` (default `--structure`,
`:31,44`).

### Argument parsing and the `f()`/`w()` finding vocabulary

Flags are hand-parsed (`:33-43`); an unknown flag or a second positional
directory is `die_usage` (exit 2). `SCAN` (the `--standards` target
directory) defaults to `$ROOT` (`:44`) and must exist (`:45`).

Every finding funnels through two local closures (`:54-57`):

```sh
f() { row_fail "$(_split_name "$1")" "$(_split_fix "$1")"; }
w() { row_warn "$(_split_name "$1")" "$(_split_fix "$1")"; }
```

`_split_name`/`_split_fix` (`:54-55`) split a message on the **first**
` — ` (em dash) into `name` and `detail` — this is the porcelain-format
split, now applied uniformly to every consumer via `lib/cli.sh`'s row
vocabulary (`row_fail`/`row_warn`, see `lib/cli.sh:97-98`). `f()` fails the
run; `w()` never does (`lib/cli.sh:18-19`, restated at `cmd-records.sh:47-49`).
The module's own contract: **"the row NAME is the problem and the DETAIL is
the fix"** (`:51-53`), and the test suite locks this shape — a `fail`-tier
row's `.name` must never itself contain ` — ` (`records-check-tests.sh:144-145`,
guarding against double-splitting that would break a machine consumer
deduping on name, I-0032).

### `--porcelain` is gone, on purpose

`:24-30` states this as design, not an oversight: `--porcelain` was a TSV
encoding of the exact same finding set that `--json` now carries as
first-class rows (name/detail/tier), invented only because `--json` used to
be `harness`-only. Its one non-test consumer (the compliance monitor hook)
was deleted by T-0186. **A TS port must not resurrect a second output
format** — this is D-0010 drift the consolidation itself exists to prevent,
and it is asserted directly: `records-check-tests.sh:198-200` proves a `w()`
warning never reaches (the now-nonexistent) porcelain output, and the whole
"2. modes and output contracts" section (`:101-200`) locks `--json` as the
one machine surface.

### The `--slurpfile` / `jpath()` mechanism (T-0193, I-0116)

Cross-journal jq checks used to receive other journals' *bodies* via
`--argjson` on the command line. `:63-72` documents a real production
incident: at HEAD, five journal bodies summed to 1,062,958 bytes against an
`ARG_MAX` of 1,048,576 — jq never exec'd, and `records check` (a
`type=lint` repo-health entry) failed on **every** `task verify`, with no
way to wait out the ceiling because journals only grow. The fix,
`jpath()` (`:96-103`), passes **paths** via `--slurpfile` instead, so jq
opens the file itself and nothing large touches argv. Two consequences a
port must reproduce:

1. `--slurpfile` wraps a file's contents in an array, so every consuming jq
   program opens with `($x[0]) as $x |` to unwrap it (e.g. `:164-166`,
   `:203-204`).
2. `--slurpfile` needs a file that exists. The old `--argjson` had a
   `|| echo '{"entries":[]}'` fallback for an absent journal; `jpath()`
   reproduces this by substituting one shared scratch file
   (`$CLI_TMP/empty-journal.json`, `:98-102`) so a fresh `GOV_ROOT` still
   validates rather than erroring.

Small **computed** projections (id lists) stay on `--argjson` because they
are bounded by id count, not journal body size (`:84-85`, e.g. `:269`,
`:308-310`).

### Scratch files live in `$CLI_TMP`; this module installs no trap

`:86-94` documents a real regression and its fix: the module used to
`trap _vcleanup EXIT`, and POSIX `sh` allows exactly one EXIT trap — the
second one **silently replaced** `lib/cli.sh`'s own
`trap 'rm -rf "$CLI_TMP"' EXIT`, so every `records check` run leaked its
whole `$CLI_TMP` directory. Measured before the fix: thousands of orphaned
directories, 105MB of TMPDIR. **Port note for the TS port specifically:**
there is no trap-collision hazard in TS the way there is in `sh`, but the
underlying invariant — exactly one process-exit cleanup owner, scratch
files scoped to one location — should still be preserved so a JS/TS
exception path can't leak temp files the way the bash one did.

### Never a piped `while` — subshell finding loss (T-0129)

Three separate call sites (`count_sweep` at `:107-125`, the admission
sweep at `:225-249`, the §9a repo-health path sweep at `:357-370`) all use
`while IFS= read -r x; do ...; done <<HEREDOC` rather than
`... | while read ...`. The comments at `:127-130`, `:223-224`, and
`:355-356` all cite the same measured defect: a piped `while` runs in a
**subshell**, so every `f()`/`w()` call inside it increments a `FINDINGS`
counter that dies with the subshell — the script prints `FAIL` lines to the
terminal and **still exits 0, reporting "clean"**. This is the load-bearing
mechanism behind why `count_sweep`'s output routing looks the way it does,
and it is the exact failure class `records-check-tests.sh:174-181` proves
does not recur ("a reported schema violation must COUNT — f() is running in
a subshell again" is the failure message it guards against). **In the TS
port this class of bug cannot occur** (no subshells; closures share scope),
but the *test* that catches it (finding both printed and counted) should
still exist as a regression guard, because the TS equivalent — an async
iterator whose errors are swallowed, or a `.forEach` over a promise-returning
callback — has its own version of "ran and reported nothing."

### `count_sweep`: a jq failure is itself a finding

`count_sweep()` (`:107-125`) runs a jq program against one journal file and
turns every output line into an `f()` call. Critically, `[ -s "$ERRF" ]`
(`:112`) — non-empty stderr — is **itself** reported as a finding
(`:113`, "validator internal: jq failed on … — records-check itself needs
fixing; do not trust this run"), independent of whatever `$OUT` contained.
This is the same "a dependency that fails must fail closed, not pass
quietly" principle stated explicitly at `:474-479`, `:509-510`, `:514`.

### Section walkthrough (`sweep_structure`, `:131-616`)

0. **Parse + duplicate ids** (`:135-140`) — every `$GOV/*.json` must
   parse (`jq -e .`) or it's a finding naming the exact restore command
   (`git checkout -- $j`); then a duplicate-id check per file.
1. **Tasks** (`:161-204`) — id pattern, title, `acceptance_check`
   presence, the I-0147 accepted/status-mismatch check, cross-refs to
   design/decisions/issues/log, `task_order` completeness, D-0076
   acceptance-authority-actor completeness, and the "who took it" check
   (`:196-202`) — an acceptance recording nobody as `.acceptance.by` is a
   finding, added specifically because the CLI used to default `--by` to
   the literal `User`.
   Immediately after (`:205-249`), a **second, separate jq program**
   (deliberately not folded into `admission_state`, `:211-215` explains
   why: one function answers "may THIS task be admitted" for one
   candidate, the validator asks "is what's ALREADY in flight legal" over
   the whole journal with no candidate) checks the D-0084 admission
   invariants: at most one sprint has `in_progress` work, and no sprint's
   `in_progress` count exceeds its declared `parallel` cap. The comment
   at `:216-221` is a **cross-file synchronization contract**: the
   definition of a task's "home" (ratified sprint that lists it) and the
   "absent `parallel` means 1" reading must stay identical to
   `admission_state` in `lib.sh`, or the writer and this backstop
   disagree about what's legally running.
2. **Issues** (`:252-261`) — id pattern, type enum, summary, mandatory
   `resolution_pointer`, task-ref resolution.
3. **Decisions** (`:264-269`) — id pattern, required
   decision/rationale/ratified_by, `supersedes` resolution.
4. **Log** (`:272-278`) — id pattern, required what_was_done/actor,
   task-ref resolution.
   (Section 5, reviews.json, is explicitly gone — `:280-283` — the
   `gov review` command and its journal were removed by D-0076; the 145
   acceptances it carried were migrated onto their tasks.)
6. **Sprints** (`:286-298`) — id pattern, status enum, epic/hotfix
   consistency, epic resolution, ratification-record completeness and
   actor presence, task resolution, and — a **write-time gate mirrored
   as a read-time check** — every listed task must carry a `task_order`
   (D-0005: "orders are the sprint entry gate").
7. **Design** (`:301-310`) — epic→feature, feature→story,
   feature→feature (dependencies), story→feature, story acceptance
   criteria non-empty, control→surface — all cross-ref resolution within
   `design.json`'s polymorphic entry list, consumed through the
   `design_view` projection (`:150-159`, computed once per run into
   `$DESF`).
8. **Rules chain** (`:312-332`) — every `.claude/rules/*.md` must have
   YAML-delimited frontmatter (`:316`) with `name:` and `paths:`
   (`:318-319`); referenced `skills:`/`scripts:`/`hooks:` are checked to
   exist, with **skills** demoted to a warning (missing skill "fine if
   user-level; if not, it is drift", `:322`) while scripts/hooks are hard
   failures (`:326`, `:330`).
9. **repo-health** (`:335-336`, entry completeness) and **9a**
   (`:338-370`) — a *registered* health-check's command file must exist
   on disk. `:338-348` explains this replaced a removed "9b" ratchet
   (T-0185/D-0074) that used to flag *unregistered* test suites — that
   direction was deliberately dropped ("coverage of which suites a
   change should run belongs to the coverage lens"); only "registered but
   can't run" is this module's business now. Path extraction
   (`:350-366`) handles two command shapes
   (`sh tests/<name>.sh`, `.claude/scripts/<name> [args]`), skips an
   `sh`/`bash` interpreter token, and only checks tokens that look like a
   path (contain `/`).
10. **Doc rosters vs. directories** (`:372-458`, T-0080/I-0029) — every
    agent/skill/rule/script **on disk** must be named in
    `PROJECT_SPEC.MD`'s matching `## ` section (and, for skills/scripts,
    also in `SKILLS_INDEX.MD`). One direction only — prose parsing for
    the reverse (a roster entry with nothing on disk) is explicitly
    not attempted (`:375`, "not worth the false positives"). `:377-383`
    documents *why* this isn't a substring grep: it used to be, and
    passed for two wrong reasons — a name mentioned anywhere in the
    whole doc counted, and no word-boundary meant `review` matched
    inside `session-review` forever. The fix, `_rc_section()` (extract
    the section under a heading) plus `_rc_names()` (whole-name match
    with `-`/`.` as name characters, `:405-411`), closes both holes. A
    **missing roster section itself is a finding** (`:417-418`,
    `:422-424`) — "a roster that has been renamed away is exactly the
    drift this section exists to catch."
11. **Schema contracts** (`:460-515`, T-0113/I-0056/T-0140) — invokes
    `agents/lib/schema_check.py` as `python -m agents.lib.schema_check`
    (never inlined as a heredoc — `:468-472` explains an earlier inline
    version broke the code graph's parse of its host file, and a heredoc
    is not importable/testable/indexable). Run from `$CODE_ROOT` with
    `PYTHONPATH` set explicitly so `python -m` doesn't accidentally
    resolve the module relative to the caller's cwd (`:487-489`). Output
    lines prefixed `UNSUPPORTED ` become **warnings** (OQ-2/D-0085,
    `:496-499`); everything else becomes a **failure** naming the record
    and the schema (`:501-503`). The exit-code handling at `:507-511` is
    itself carefully layered: rc 1 with output is "findings, already
    handled above"; anything else non-zero (rc>1, or non-zero with empty
    output) is **the sweep itself failing** and is reported as a finding
    that says explicitly the schema contracts were **not** checked this
    run. Falls back to `python3` off `$PATH` if `$CODE_ROOT/.venv/bin/python`
    isn't executable (`:480-481`); if no python interpreter is found at
    all, that's a hard finding too (`:513-514`).
12. **Seal / tamper detection** (`:517-563`, T-0100/I-0047, D-0044) —
    four-layer check, in order: (a) is `seals.json` itself well-shaped
    (`seals_shape_problem`, `:530-533`, described as "the shape … BEFORE
    what it says"); (b) was the seal map bootstrapped over
    already-populated journals (`:534-539`, a warning, since anything
    changed before that date can't be detected — "expected in a repo
    that predates sealing"); (c) — the OQ-19/D-0085/P-52 mechanism this
    module owns directly (`:540-555`) — is every journal that's both
    on-disk and in `SEALED_JOURNALS` actually present as a key in
    `seals.json`'s `.journals` map; a journal that's on disk, in the
    canonical list, but **absent from the map** is named as a **warning**
    ("nothing is comparing it"), not silently passed and not failed; (d)
    `broken_seals` (`:556-563`) — journals whose live content hash
    doesn't match the recorded seal are **failures**, each naming the
    `repair journal` remedy.
13. **Historical-gap warnings** (`:565-615`) — three retrospective sweeps,
    all deliberately `w()` rather than `f()`, each with an inline
    rationale: self-validated issues predating the write-time refusal
    (`:565-573`, I-0054/T-0111 — explicitly *because* this script is a
    registered repo-health check and a machine consumer used to pipe
    `--porcelain` into `scrumux issue`, so an `f()` here would both redden
    the repo *and* mint one drift issue per historical row); acceptances
    with no recorded authority (`:574-590`, P-07, 145 historical rows);
    ratifications with no recorded authority (`:592-608`, same
    2026-08-28 cutover, same reasoning, and `sprint.schema.json`
    deliberately does not require the field).

### `sweep_standards` (`:620-636`)

Deliberately empty of built-in rules. `:623-631` states why: the three
mechanical stack rules that used to live here (Python/TypeScript only,
LangGraph for agents, no mock LLM calls) were "one person's stack hardcoded
into a harness whose stated contract is that it governs any repo in any
language." Removed; a repo now states its own standards in
`.claude/rules/project-standards.md` and registers anything mechanical via
`scrumux health add`. The function prints two `say()` lines and adds no
findings — it must not clear the structure half's findings under `--all`
(`:635`), and the dispatch at `:638-642` confirms `--all` runs both sweeps
with a blank `human ""` line between them, never letting one clobber the
other's row state (rows are accumulated centrally in `lib/cli.sh`'s
`$CLI_ROWS`, not in this module).

### Final emit (`:644-656`)

After whichever sweep(s) ran, `cli_fails` (a count of `tier=="fail"` rows,
`lib/cli.sh:104`) decides the summary line's content but **not** the exit
code — the exit code is decided by `lib/cli.sh`'s row-tier→verdict mapping
(P-01), which this module never touches directly. `:646-650` prints the
"N finding(s)" summary with the `scrumux issue new --source governance-validate`
suggestion (comment at `:647-648` notes the source vocabulary keeps the old
name even though the checker itself is now `records`); `:651-655` prints a
mode-specific "clean" sentence, always — even when there were findings,
since `emit()` in `lib/cli.sh` composes the object/verdict from the
accumulated rows, not from this string.

---

## Deliberate looseness

Every item below is a **behavior**, not a defect. Each is mapped to its
PHILOSOPHY.md item where one exists.

1. **`w()` findings never move the exit code, structurally, not just by
   convention.** — PHILOSOPHY P-01. This module's whole warning vocabulary
   (self-validated issues, no-authority acceptances/ratifications, an
   incomplete seal map, a bootstrapped-over-existing-content seal) rests on
   `row_warn` recording `tier: "warn"`, which `lib/cli.sh`'s exit-code
   mapping never reads as a failure.
2. **145 accepted tasks and an unspecified number of ratified sprints with
   no recorded authority are warned on forever, never bulk-repaired.** —
   PHILOSOPHY P-07, cited verbatim at `cmd-records.sh:265-580` (this *is*
   the origin site P-07 points at). Extends identically to
   `sprint ratify` (`:592-608`) — same cutover date, same "inventing an
   authority would be worse than the gap" reasoning, not previously called
   out by number in PHILOSOPHY.md but the same mechanism.
3. **A sealed-listed journal absent from the seal map is a WARNING, never a
   failure, and only fires per this module's own new check** (`:540-555`).
   — PHILOSOPHY P-52/OQ-19, and RULINGS.md D-0085 explicitly answers OQ-19's
   question: yes, warn, never fatal, the P-07 treatment. **Already resolved
   — not open** in this doc's Open Questions, per the task framing ("OQ-19
   … is already ruled in").
4. **Self-validated issues (pre-refusal) are warnings, explicitly to avoid
   double damage** (`:565-573`) — turning the repo red *and* minting one
   drift issue per row through a porcelain-reading monitor. NEW (not a
   named PHILOSOPHY.md item, but the identical shape as P-07/P-52 — a
   retrospective observation over historical rows staying non-fatal so a
   detector doesn't teach the operator to ignore it). Candidate for the
   register as an explicit item alongside P-07.
5. **Unsupported schema keywords are reported, never enforced, and never
   fail the sweep.** — PHILOSOPHY P-34/OQ-2. RULINGS.md D-0085 records this
   as already wired in bash (the `UNSUPPORTED ` branch at `:496-499`) and
   locked by `records-check-tests.sh:277-304`.
6. **A schema sweep that cannot run at all is a hard *failure*, not a
   silent pass** (`:507-514`) — this is the inverse of "loose": it's a
   place the module deliberately refuses to be quiet about degraded
   coverage. Cited generally under P-34's "reader is a deliberate subset"
   framing but the fail-closed-on-tool-absence behavior is its own thing —
   flagging it here as the counterpart to item 5, so a porter doesn't read
   "unsupported keywords are lenient" and assume the whole schema path is
   lenient.
7. **`design.json` is validated for cross-refs here (structure sweep §7)
   but never schema-checked** — PHILOSOPHY OQ-3, unresolved (design.json
   absent from `schema_check.PAIRS`). This module's §7 (`:301-310`) is
   *reference-integrity* checking, which is a different and narrower thing
   than the schema contract check in §11 — worth stating precisely because
   a port could conflate "design.json has checks in cmd-records.sh" with
   "design.json is schema-validated," which OQ-3 says is not established as
   intentional.
8. **The doc-roster sweep (§10) checks one direction only** — disk → docs,
   never docs → disk (`:375`). NEW as a named item (not in PHILOSOPHY.md
   under its own number), but explicitly reasoned in-line as a deliberate
   scope choice ("not worth the false positives"), not an oversight.
9. **Rules-chain warnings vs. failures are asymmetric by pointer type**
   (`:322` skill pointer → `w()`, "fine if user-level"; `:326`/`:330`
   script/hook pointer → `f()`). NEW as a named item — reasoned inline, not
   cited by number in PHILOSOPHY.md, but the same class of judgment call
   PHILOSOPHY.md documents elsewhere (P-06-style demotion, though this one
   was apparently never a full block).
10. **`sweep_standards` is deliberately empty** and its emptiness is itself
    the design (`:623-636`) — related to but distinct from P-39
    (`project-standards.md` ships empty and unenforced): P-39 is about the
    *file* a repo writes into; this is about the *command* that used to
    contain hardcoded stack opinions and now contains none. NEW pairing,
    worth registering alongside P-39 since a porter reading only P-39 might
    still port the three retired stack rules into `sweep_standards`
    thinking they belong somewhere.
11. **`--porcelain` was removed entirely, and its removal is itself the
    "looseness"** in the sense that a port must resist recreating a second
    machine format "for compatibility." Directly stated design intent
    (`:24-30`), not previously a PHILOSOPHY.md item by number. NEW.

---

## Simplify/perf

**BEHAVIOR-PRESERVING**

- **One parse per journal, not one per section.** Sections 1–7 currently
  each independently `jq`-parse their target file via `count_sweep`
  (separate `jq -r … "$file"` subprocess invocations at `:162`, `:252`,
  `:264`, `:272`, `:286`, `:301`) plus the up-front `jq -e .` validity check
  in section 0 (`:137`). A TS port reads and JSON-parses each journal
  **once**, and every section's checks run as in-memory traversals over
  that one parsed value — this is exactly the class of change the plan
  pre-approves (PHILOSOPHY "What this register is NOT": "one parse per
  journal … is sanctioned by the plan").
- **No subprocess `jq`/`shasum`/`awk`.** Every `count_sweep` call, the
  `_rc_section`/`_rc_names` awk/grep/sed pipeline (`:393-411`), the seal
  hash comparisons (delegated to `lib.sh` functions not in this file, but
  invoked here at `:530`, `:551`, `:556`) — all become native TS. Preserve
  exact **output semantics**, not implementation: the `jpath()`
  empty-journal substitution (§ above) becomes "treat an absent file as
  `{entries:[]}`" as a plain conditional, no scratch file needed at all in
  TS since there's no `ARG_MAX`/subprocess boundary to route around. This
  is the resolution of the entire T-0193/`jpath` mechanism — the *problem*
  `jpath` solves (argv size limits calling a subprocess) doesn't exist when
  the checks are in-process TS, so the port doesn't need `jpath`'s
  machinery, only the **behavior** it protects (an absent journal reads as
  empty, not as an error).
- **The Python schema-check subprocess call (§11) can become a direct TS
  import/call**, since the port also ports `agents/lib/schema_check.py`'s
  logic (per PHILOSOPHY P-34, "hand-rolled subset port"). Preserve exactly:
  the `UNSUPPORTED ` line → warning / everything-else → failure split
  (`:495-504`), and the three-way exit-code disposition at `:507-511`
  (findings-with-output vs. tool-failure vs. clean) — this becomes a
  function return shape (e.g. a discriminated result), not a subprocess
  exit code, but the three outcomes and their tiers must be preserved
  identically.
- **`_split_name`/`_split_fix`'s em-dash split** (`:54-55`) is pure string
  logic and trivially ports; preserve "split on the **first** ` — `,
  fall back to a generic 'run scrumux records check' fix string when
  there's no em dash" exactly, since `records-check-tests.sh:144-145`
  encodes this as a contract (a fail-tier name must never itself contain
  ` — `).
- **The doc-roster section (§10)'s section-extraction and whole-name
  matching** (`:393-411`) is straightforwardly portable to a regex/string
  routine; preserve the "whole name, `-`/`.` counted as name characters"
  semantics exactly (this is the fix for the substring-match bug the
  comment at `:377-383` documents — a naive `.includes()` port would
  reintroduce it).
- **`$CLI_TMP` scratch-file usage** (design-view projection, roster section
  captures, schema-sweep stdout/stderr capture) has no TS equivalent need —
  these all become in-memory values. No behavior to preserve here beyond
  "don't write temp files unnecessarily"; the bash version's temp files
  were themselves a workaround for shell's lack of structured in-process
  data, not a deliberate design choice worth preserving as *files*.

**OBSERVABLE** (proposal only — User rules)

- *(None proposed.)* Every behavior in this module that could look like a
  simplification target is either already covered by a named PHILOSOPHY.md
  looseness (do not touch) or is pure-mechanism (subprocess elimination,
  parse consolidation) with no operator-visible change. No OBSERVABLE
  changes are proposed for this module.

---

## Open questions

1. **Does the §9 "9a" repo-health command-path extraction need to survive
   unchanged, or does it get subsumed by however the TS port models a
   health-check registry entry?** `:350-366` is a heuristic string parser
   (first whitespace token, skip `sh`/`bash`, require a `/` in what's
   left) built around two known command shapes. If the TS port's health
   registry ever gains a structured `{interpreter, path, args}` shape
   instead of a free-text `command` string, this whole heuristic becomes
   unnecessary — but that would be a schema change to `repo-health.json`,
   outside this module's scope, and this module must keep parsing the
   **current** free-text shape until that lands. File: `cmd-records.sh:350-366`.

2. **POSIX vs. JS regex hazard in the id-pattern checks.** Every id-pattern
   check (`:167` `^T-[0-9]{4}$`, `:255` `^I-[0-9]{4}$`, `:266` `^D-[0-9]{4}$`,
   `:275` `^L-[0-9]{4}$`, `:289` `^SP-[0-9]{4}$`) is run through jq's regex
   engine (Oniguruma), not `grep -E`/POSIX ERE — so OQ-8's ERE-vs-RegExp
   concern doesn't directly apply here (these are already a PCRE-like
   engine, closer to JS `RegExp` semantics than POSIX ERE is). Low risk,
   but worth a smoke-test: these five patterns are simple anchored
   character classes with no POSIX-specific constructs, so a literal
   `RegExp` port should reproduce them byte-for-byte — confirm rather than
   assume.

3. **`_rc_section`'s heading match is case-insensitive and prefix-based**
   (`:398`, `index(tolower(line), tolower(want)) == 1` — the section title
   must **start with** the wanted word, case-insensitively, not equal it
   exactly). A section titled "## Agents (roster)" matches `want="Agents"`;
   a section titled "## The Agents" would not (prefix, not substring). File:
   `cmd-records.sh:394-403`. Confirm the TS port's string-prefix check uses
   the same "starts with, case-insensitive, exact word-count-1 match on
   `## `" semantics — an easy place for `.includes()` to over-match.

4. **`awk`'s field/record semantics in `_rc_section`** (`:393-403`) — the
   awk script tracks `inside`/`found` as awk truthiness (0/1, uninitialized
   = false) and uses `exit found ? 0 : 1` as its signal to the caller. A
   naive line-by-line TS port must reproduce: (a) the function stops
   scanning at the **next** `## ` heading, even one that doesn't match
   (`:396`, `if (inside) exit`); (b) a file with **no** matching section
   prints nothing and the caller treats that as "section missing"
   (`:417-420`, `:422-425`) via the exit code, not via empty output alone
   (an empty *but present* section is legitimate and must not be confused
   with a missing one — though this module doesn't appear to test that
   distinction explicitly, so verify with a targeted test in the port).

5. **Locale/sort-order hazard: none identified.** No `sort`, `LC_*`-
   sensitive comparison, or locale-dependent string ordering appears
   anywhere in this module — every list operation is jq's own ordering
   (stable, insertion-order-preserving) or awk pattern matching. Noting
   the absence explicitly so a reviewer doesn't need to re-check.

6. **Subshell exit-code swallowing: already the module's own documented
   concern, and already fully covered above** (see "Never a piped `while`"
   in Intent). No additional hazard beyond what's already narrated — but
   flagging for the port that the **regression test** for this class
   (`records-check-tests.sh:174-181`, "a reported schema violation must
   COUNT") should get a TS-side equivalent even though the *mechanism*
   (subshell scoping) can't recur in TS, because the *symptom* (a check
   that logs a failure but doesn't count it) can recur through other means
   (an unawaited async callback, a `.catch()` that swallows without
   re-throwing, an array `.filter()` side-effect that never runs because
   the array is empty).

7. **`printf format` edges: none identified as load-bearing.** The
   module's `printf` calls are all `%s\n` with either quoted literals or
   values passed as `%s` arguments (no `%d`, no unquoted interpolation into
   the format string itself) — e.g. `:100` `printf '%s\n' '{"entries":[]}'`.
   No numeric-formatting or field-width edge case to worry about porting.

8. **§9a's `[ -e "$rh_path" ]` check (existence, not "is a regular file"
   or "is executable")** (`:366`) — a registered check whose command file
   exists as a *directory* would pass this existence test and then fail at
   actual invocation time with a different, more confusing error. Not
   verified as deliberate (no comment addresses the `-e` vs `-f` choice
   specifically), but also not contradicted by any test — the fixture in
   `records-sweep-tests.sh` only exercises the missing-file and
   present-file cases (`:100-115`), never a directory-shaped one. Flagging
   as file:line `cmd-records.sh:366` for a port decision: match `-e`
   (existence only) exactly, since anything else is tightening.

9. **The `--all` mode's ordering (`structure` then `standards`,
   `:641`) is asserted by exactly one test** (`records-check-tests.sh:260-274`,
   proving structure findings surface under `--all` and that `--standards`
   alone doesn't leak structure findings) but the **reverse** order —
   whether `standards` findings would also surface correctly if structure
   ran second — is not independently tested, since `sweep_standards`
   currently never emits findings at all (item 10 in Deliberate looseness).
   If a future repo's `project-standards.md`-registered checks ever route
   findings back through this same `f()`/`w()` mechanism (not currently
   the case — `scrumux health add` checks are separate,
   `repo-health.json`-registered, and run elsewhere), the ordering
   guarantee would need its own test. Not a current defect — noting it so
   the port doesn't assume today's one-directional test proves more than
   it does.
