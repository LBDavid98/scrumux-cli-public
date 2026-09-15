# Module inspection — design-nouns

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

**Files:** `.claude/scripts/lib/cmd-epic.sh` (95 lines), `cmd-feature.sh` (59),
`cmd-story.sh` (62), `cmd-issue.sh` (239), `cmd-exception.sh` (179),
`cmd-decide.sh` (106), `cmd-rank.sh` (166), `cmd-log.sh` (83). Every line of
all eight was read. Shared machinery in `lib/journal.sh` and the relevant
slices of `lib.sh` and `lib/cli.sh` was read alongside them, since none of
these eight files is comprehensible without it.

---

## Intent

All eight files are **record-writing noun modules**, sourced by the
`scrumux` dispatcher after `lib.sh` and `lib/cli.sh` are already loaded
(`scrumux:58-59`). They share one shape almost mechanically:

1. Parse flags with a `while [ $# -gt 0 ]; do case "$1" in … esac; done` loop,
   collecting scalars into shell variables and repeated flags into a
   variable holding **jq-serialized JSON text**, not a shell array (see
   Deliberate looseness, below).
2. Validate: non-empty required fields (`[ -n "$X" ] || die '…'`), enum
   fields (`case "$X" in a|b) ;; *) die '…';; esac`), and foreign-key refs
   via `ref_exists` / `require_task_ref` (`journal.sh:17-25`).
3. Create the journal if absent (`ensure_file`, `lib.sh:95-99`, or the
   `design_ensure` wrapper at `journal.sh:193` shared by epic/feature/story).
4. Write: either `append_with_id` (new records: epic/feature/story new,
   issue new, exception new, decide new, log new) or `write_json` directly
   (mutations: epic update, issue update/validate/authorize, exception
   resolve, decide's supersession stamp, rank, log's second write).
5. `seal_bootstrap; emitted "$ID"` (creations) or `seal_bootstrap; emit
   "…"` (mutations) — the one exception is noted below.

**The free-text die messages are the load-bearing UX, not decoration.**
Every `--name`/`--desc`/`--summary`/`--fix`/`--narrative`/`--criterion`/
`--finding`/`--decision`/`--rationale`/`--title`/`--did` refusal embeds a
full GOOD/BAD worked example lifted from this repo's own real records —
`cmd-epic.sh:44-45`, `cmd-feature.sh:14-15`, `cmd-story.sh:15-16`,
`cmd-issue.sh:46,161-162`, `cmd-exception.sh:40-42`, `cmd-decide.sh:20-22`,
`cmd-log.sh:17-18`. This is Article 5 ("the error message is the
instruction set") applied at maximum density: the refusal is the only
teaching surface an agent gets before it writes governance prose, so the
message *is* the spec for what a good field looks like. A port that
shortens these to "field X is required" has silently deleted a training
signal, not just trimmed a string. **Port the full text, including the
cited record ids** (E-0005, F-0009, S-0069, I-0153, X-0001, D-0084,
L-0285, …) — they are load-bearing citations, not filler.

**Shared allocator.** `append_with_id` (`lib.sh:313-319`) takes the
journal lock, calls `next_id` (`lib.sh:608-610`, `jq … tonumber | max // 0
+ 1`) to compute `NEW_ID`, then calls `_write_json_body` under the same
lock before unlocking — this is what closes the two-processes-same-id race
that `journal-lock-tests.sh` exercises directly against `task new` and
`issue new` (`journal-lock-tests.sh:28-74`; trial count and the "grew by
one instead of two" framing are literal quotes from that file's own
comment). **Every id-allocating verb in this module (epic/feature/story
new, issue new, exception new, decide new, log new) depends on this exact
mechanism** and inherits its one open hazard: `next_id` crashes on a
non-numeric id suffix and silently hands out a duplicate at rc 0
(PHILOSOPHY.md OQ-7, **approved as a divergence under D-0085**: the TS
`nextId` refuses a malformed id instead of reproducing the duplicate).
Nothing in this module needs to re-derive that — it is inherited from the
shared allocator, cite D-0085/OQ-7 and move on.

**Two of the eight verbs perform a second, separately-locked write after
their primary one**, and neither is atomic with the first:

- `decide new --supersedes D-OLD` appends the new decision under one lock
  (`cmd-decide.sh:29`), then stamps `superseded_by` onto the old entry
  under a **second** `write_json` call (`cmd-decide.sh:53-56`). A crash
  between the two leaves a new ratified decision on record whose
  predecessor does not yet know it is dead — `DECISIONS.MD`'s renderer
  (`journal.sh:58-70`) would show both as live until the second write
  lands or is retried.
- `log new --task T-0001` appends the log entry under one lock
  (`cmd-log.sh:21`), then pushes the new log id into that task's
  `log_entries` array under a **second** `write_json` call
  (`cmd-log.sh:29-30`). Same shape, same window.

Neither site comments on this, and nothing in PHILOSOPHY.md addresses it
directly — it is a real gap between "the write engine treats one journal
write as atomic" (which `_write_json_body`'s guards genuinely give you)
and "an operation that touches two journals is atomic across both" (which
nothing gives you, here or anywhere else the CLI touches two files). See
Open Questions.

**`rank` is the one noun in this group with no id of its own** — it
mutates `design.json` (features) or `tasks.json` (tasks), dispatched on
the ref's prefix (`cmd-rank.sh:26` `case "$REF" in F-*) … esac`). The F-*
branch ends by calling `emit` (`cmd-rank.sh:55`), which **exits the
process** (`cli.sh:176`) — so the unconditional `[ -f "$GOV/tasks.json" ]`
guard at `cmd-rank.sh:57` is unreachable for a feature ref; this is a
dispatch-by-exit pattern, not a fallthrough bug, and it must be preserved
as an early-return in the TS port (not a `switch` that falls through).

**Free-text fields carry no structural check beyond non-empty.** No field
in this module enforces a maximum length, a minimum sentence count, or any
shape beyond `minLength: 1` in the schema and `[ -n "$X" ]` in the shell —
the worked GOOD/BAD examples in the die messages are the entire quality
mechanism, and it is a social one, not a mechanical one. This matches
Article 4 (a check claims only what it computes) and is not a defect to
close; noted so the port does not "improve" it with a word-count minimum
nobody asked for.

**`issue validate`'s self-validation guard** (`cmd-issue.sh:58-72`) is
PHILOSOPHY.md **P-47** verbatim — disjointness only, User hard-exempted
by literal string comparison (`[ "$BY" != User ]`), no roster allowlist.
Reproduced in `issue-validate-tests.sh:63-137` at length, including the
I-0099 requirement that the refusal not prescribe the exact `--by` value
it just refused (`issue-validate-tests.sh:86-89,109-112`).

**`governance/exceptions.json` is this repo's live example of two other
PHILOSOPHY entries**, both about the very journal `cmd-exception.sh`
writes: it is the **P-48** empty-journal-is-valid case (16 bytes, in
`SEALED_JOURNALS`, schema-checked, reports nothing when empty), and it is
the **P-52/OQ-19** live instance of a sealed-listed journal that is
*absent from `seals.json`'s key map* — `jq -r '.journals|keys[]'
governance/seals.json` returns seven names against an eight-name
`SEALED_JOURNALS`, and `exceptions.json` is the missing one, right now, in
this repo. A port that "fixes" this by warning on an incomplete seal map
would be inventing a finding this system does not raise (P-52's own
port note) — see Open Questions for the one thing about *this* module
that touches that gap directly.

---

## Deliberate looseness

- **Rank is never manufactured — features included.** `feature new`
  (`cmd-feature.sh:20-22`) leaves `.rank` unset exactly as `task new` does.
  **PHILOSOPHY P-44.** `backlog-tests.sh:79-86` pins the task-side version
  of this; the feature-side version is exercised at
  `backlog-tests.sh:134-151` (`TASKRANKS_BEFORE`/`AFTER` equality after a
  feature-only rank move).

- **A seeded journal is not jq-canonical, ever, until its first write.**
  Every `ensure_file "$GOV/…json" '{"entries": []}'` call in this module —
  `design_ensure` for epic/feature/story (`journal.sh:193`, called at
  `cmd-epic.sh:46`, `cmd-feature.sh:16`, `cmd-story.sh:17`), and the direct
  calls at `cmd-issue.sh:165`, `cmd-exception.sh:50`, `cmd-decide.sh:28`,
  `cmd-log.sh:20` — writes the literal 16-byte `printf` template, not a
  jq-rendered one. **PHILOSOPHY P-49.** Reproduce the exact bytes; do not
  route creation through the port's own serializer even though it would be
  "more consistent."

- **`issue validate` refuses disjointness only, User is a hardcoded
  exemption, no roster.** **PHILOSOPHY P-47**, `cmd-issue.sh:58-72`.

- **`governance/exceptions.json` empty is a valid, unremarkable journal.**
  **PHILOSOPHY P-48.**

- **Repeated flags accumulate with no de-duplication**, across every noun
  that has one: `--feature` on `epic new` (`cmd-epic.sh:41`), `--dep` on
  `feature new` (`cmd-feature.sh:11`), `--criterion` on `story new`
  (`cmd-story.sh:11`), `--file`/`--waives` on `issue new`
  (`cmd-issue.sh:132-133`), `--pending` on `log new` (`cmd-log.sh:14`).
  `epic new --feature F-0001 --feature F-0001` writes `features:
  ["F-0001","F-0001"]`; nothing dedupes it going in or reading it back.
  **NEW** (candidate for the register — no comment or ruling addresses
  this; it is consistent enough across five call sites that it reads as
  designed-in rather than missed, but nothing says so).

- **`--file` on `issue new` is not checked against the filesystem.** A
  filed issue can name a path that does not exist; nothing resolves it.
  (`cmd-issue.sh:132`). **NEW.**

- **`exception new --session` / `--rule` are unvalidated free text**, with
  no reference check against any session registry or `.claude/rules/*.md`
  — unlike `--task`, which goes through `require_task_ref`
  (`cmd-exception.sh:34-37`; contrast the schema's own pattern constraints
  on `session`/`sprint`/`rule` in `.claude/schemas/exception.schema.json`,
  which are checked only later, by `records check`, never at write time).
  **NEW** — though note this matches the module's general architecture
  (schema enforcement is a separate, later pass; see P-34 and OQ-3) rather
  than being an outlier.

- **`exception`'s dispositions are recommendations the CLI never acts
  on.** `--disposition` is validated as one of four enum values
  (`cmd-exception.sh:44-47`) and then simply stored; nothing in this file
  moves a task, ratifies anything, or performs the disposition it names.
  This is stated explicitly and at length in the file's own header
  (`cmd-exception.sh:17-21,64-70`) as "a reviewer is never a blocker" —
  fully deliberate, clearly reasoned, but **no PHILOSOPHY.md entry names
  it**. **NEW** (candidate for the register — strong existing rationale in
  the source, just not yet catalogued alongside the other structural
  loosenesses).

---

## Simplify/perf

**BEHAVIOR-PRESERVING:**

- **One parse per journal, not one jq process per check.** `epic update`
  alone makes five separate `jq`/`ref_exists` subprocess calls against the
  same `design.json` for one invocation (`cmd-epic.sh:11,22-24,27-28,48`).
  Read the journal once, hold it as a parsed value, and run every
  ref-exists / enum / membership check against that in-memory structure;
  write it back once. Same pattern across all eight files wherever
  `ref_exists` is called more than once per verb.

- **Repeated-flag accumulation without a subprocess per flag.** The
  `VAR=$(printf '%s' "$VAR" | jq --arg x "${2?}" '. + [$x]')` idiom spawns
  one `jq` process per repeated flag (`cmd-epic.sh:15-16,41`;
  `cmd-feature.sh:11`; `cmd-story.sh:11`; `cmd-issue.sh:132-133`;
  `cmd-log.sh:14`). A native array push replaces all five call sites
  identically, including the accumulate-then-validate-then-write ordering
  (validate each element against the journal before the write, exactly as
  now).

- **`cmd-rank.sh` is the densest concentration of subprocess text-munging
  in this module** and the highest-value target for "no subprocess
  awk/sed/grep": the insert-at-position idiom
  (`awk -v pos=… -v id=… 'NR==pos{print id} {print} END{if (NR<pos) print
  id}'`, at `cmd-rank.sh:42` for features and `:104` for tasks), the
  positional lookup (`sed -n "${REF}p"`, `:75`), and the
  count/exact-match idiom (`grep -c .`, `:32,63`; `grep -x`, `:34,71,78`)
  all reduce to array splice / index-of / length operations in TS. Keep
  the **algorithm** (build the current ranked-only order, remove the
  moved id, re-insert at the clamped position, re-densify 1..K over
  ranked entries only — never touching unranked ones) byte-for-byte; only
  the mechanism changes.

- **`next_id`'s subprocess `jq … tonumber | max // 0 + 1`**
  (`lib.sh:608-610`) is shared by every id-allocating verb in this module
  and reduces to an in-memory max-plus-one. Preserve the
  D-0085/OQ-7-approved divergence (refuse a malformed id rather than
  reproduce bash's silent duplicate-id allocation) rather than re-deriving
  a decision on it here.

No OBSERVABLE simplify/perf items are proposed for this module beyond
what is already flagged as an open question below (the redundant
`reseal_one` call and the rank clamp) — those are correctness/behavior
questions, not performance ones, and are listed there rather than here so
they get a ruling rather than being applied as "obviously fine" cleanup.

---

## Open questions

### OQ-DN1 · `exception resolve` is the only write in this module that does not call `seal_bootstrap`, and it reseals its journal twice

Every other write-verb in this module ends `seal_bootstrap; emit(ted)
…` — confirmed by grep across all eight files. `exception_resolve`
instead calls `write_json` (which already reseals internally via
`_write_json_body`'s trailing `reseal_one "$f"`, `lib.sh:293`) and then
calls `reseal_one "$GOV/exceptions.json"` a **second** time, explicitly,
at `cmd-exception.sh:90-93`.

In the common case this is simply redundant — the second call recomputes
the same sha256 over unchanged content. But `write_json` releases the
journal lock as soon as `_write_json_body` returns (`lib.sh:300-304`), and
the explicit second `reseal_one` at `cmd-exception.sh:93` runs **outside
any lock**, after that release. A hand-edit to `exceptions.json` landing
in that window would be hashed and sealed by the second call as if
`scrumux` had written it — the exact class of laundering `reseal_one` was
narrowed (P-13) specifically to avoid, applied here to itself by the
double call. **Not reproduced under an actual race** — this is a reading
of the lock lifetime, not a measured failure, and it is the narrowest of
windows (two near-instant local calls). Also, because `exception_resolve`
never calls `seal_bootstrap`, if `exceptions.json` were ever the *first*
journal written in a repo with no `seals.json` yet — not reachable via the
CLI today, since `resolve` requires an existing `X-` id that only
`exception new` can create, and `exception new` does call
`seal_bootstrap` — `seals.json` would not get created by this path alone
(`reseal_one` no-ops when `seals.json` is absent, `lib.sh:329`).

**Question:** is the second `reseal_one` call intentional (belt-and-braces
against some case not otherwise visible), or is it a straightforward
duplicate of what `write_json` already does, safe to drop? Not fixed here
either way — ported as-is pending a ruling, and the port should reproduce
the same two-call, lock-released-between-them shape rather than "cleaning
it up" into a single call, since that single-call version would be an
observable (if extremely narrow) behavior change to the laundering
window.

### OQ-DN2 · `issue update --waives` replaces the array rather than appending to it

`cmd-issue.sh:96` accumulates `--waives` flags from *this* invocation into
`WVS` (starting from `'[]'` every call), and the write at
`cmd-issue.sh:115` is `(if ($w|length)==0 then . else .waives=$w end)` —
a full assignment, not a merge with the issue's existing `.waives`. An
issue created with `.waives: ["T-0001","T-0002"]` (via `issue new
--waives T-0001 --waives T-0002`) and later updated with `scrumux issue
update I-0001 --waives T-0005` ends up with `.waives: ["T-0005"]` —
T-0001 and T-0002 silently gone from the record. `--task`'s analogous
replace (`.refs.task=$tk`, same block) is correct for a single-valued
field; the same replace semantics on an array field looks like a
different case.

No comment addresses this, and I found no test that exercises
`issue update --waives` on an issue that already has a non-empty
`.waives` from creation — `journal-lock-tests.sh` and
`issue-validate-tests.sh` are the only two suites that touch `issue`
substantially, and neither drives `update --waives` on a pre-waived issue.
**Not verified as a defect** — it may be intentional ("update replaces
the waiver set wholesale" is a defensible reading, since a waiver list is
supposed to be a deliberate, complete statement of what's excepted, not
an accretion). Flagged because the two readings produce materially
different data, and only User's intent settles which one the port
should reproduce as *the* contract rather than as an accident to fix.

### OQ-DN3 · `rank`'s out-of-range position silently clamps rather than refusing

Both the feature path (`cmd-rank.sh:41`) and the task path
(`cmd-rank.sh:103`) do `[ "$NEWPOS" -le "$FMAX/$MAXPOS" ] || NEWPOS=$FMAX`
— a `rank set T-0003 999` against a three-item ranked list silently places
the item last (position 3), rather than refusing with the valid range the
way an unknown id is refused (`cmd-rank.sh:74`,
`backlog-tests.sh:175-177`). No comment states this is deliberate, and I
found no test asserting the clamp specifically (the existing rank tests
in `backlog-tests.sh` all move to positions within range). It reads as
plausibly deliberate — clamping is a friendlier failure than a refusal
for "put this last-ish" — but that is a guess, not a citation. **Not
verified either way.** Ported as-is (clamp, not refuse) pending a ruling;
flagged because the failure-vs-clamp choice is exactly the kind of thing
`backlog-tests.sh:175-177` shows the *sibling* case (unknown id) landing
the other way.

### OQ-DN4 · Two-journal writes in this module (`decide --supersedes`, `log --task`) are not atomic across both journals

See Intent, above, for the mechanism: `decide new --supersedes` and
`log new --task` each make two separately-locked `write_json`/
`append_with_id` calls, and a crash between them leaves the first write
durable and the second one not yet applied — a decision whose predecessor
doesn't yet know it's superseded, or a log entry the task doesn't yet
reference. Nothing in either file, in `journal.sh`, or in PHILOSOPHY.md
addresses cross-journal atomicity; every existing guard
(`_write_json_body`'s five checks, the journal lock, the entry-count
guard) is scoped to a single file. **Not verified as a live problem** — no
reproduction attempted, and the two-write shape is small and fast enough
that the window is narrow. Surfaced because a TS port with a real
transaction primitive available (or a temptation to wrap both writes in
one `Promise.all`) would either close this gap silently (an improvement
nobody asked for and a differential-visible behavior change under a
crash-injection test) or paper over it in a way that changes which write
"wins" on partial failure. Recommend a ruling before the write engine
locks this in either direction, same footing as OQ-14's "write the
already-checked bytes" question in PHILOSOPHY.md.

### OQ-DN5 · `design.json` (epic/feature/story) is never schema-checked — this module is the write side of PHILOSOPHY OQ-3

`schema_check.PAIRS` (`agents/lib/schema_check.py:144-158`) does not
include `design.json`, even though `.claude/schemas/design.schema.json`
is a complete, `additionalProperties:false` schema covering exactly the
shapes `cmd-epic.sh`, `cmd-feature.sh` and `cmd-story.sh` write (epic,
feature, story, plus surface/control/wireframe_ref kinds this module
never produces). Write-time validation in these three files (non-empty
name/desc/narrative, at least one criterion, ref-checked
feature/dependency/story ids) is real but is **not** the same guarantee
`records check` gives issues/exceptions/decisions/log/tasks/sprints — an
epic record with an unexpected extra key, for instance, would pass
`epic new` today and never be caught by any later sweep. This is
PHILOSOPHY.md's own **OQ-3**, restated here because it lands squarely
inside this module rather than being a general architecture note: **the
absence is plausibly deliberate** (design.json is a polymorphic
`{kind:…}` journal and `check_journal` validates every entry against
*one* schema, which doesn't fit six kinds under one call the way the
seven `PAIRS` journals do) but is not confirmed as such by any comment or
ruling. Same question as OQ-3, same answer required before the port
decides whether epic/feature/story records get a schema pass or stay
write-time-only.
