# Module inspection — read-verbs-small

> Pinned at 9c15d04 — file:line references resolve against `git show 9c15d04:<path>`; the tree may have moved.

Source (all under `.claude/scripts/lib/`, relative to repo root):
`cmd-backlog.sh` (183 lines), `cmd-views.sh` (44), `cmd-memory.sh` (65),
`cmd-health.sh` (52), `cmd-secret.sh` (188). Every line of all five was read.
Shared machinery cited from `lib.sh`, `lib/cli.sh`, `lib/journal.sh` as needed
— those files are inspected in their own module docs; here they are cited
only where this module's behavior depends on their exact contract.

---

## Intent

Five small nouns, one verb apiece except `backlog` (two) and `secret`
(three). What unifies them: none does anything beyond read-and-render or a
single guarded write, and each carries a comment block that is itself part of
the contract (Article 5 — human-mode prose is product surface).

### `backlog` — priority order over open work, split by whether anyone decided

`backlog_list` (`cmd-backlog.sh:15-151`) serves both `backlog tasks` and
`backlog features` through one function, branched on the `FEATURES` bool
passed by `backlog_run` (`:176-183`). The two branches are structurally
identical and both were read in full:

- **Absence is normal.** No `design.json` → `"(no features)"`-style message,
  rc 0 (`:32`). No `tasks.json` → `"(no tasks.json — nothing to rank)"`, rc 0
  (`:88-91`). This is the tri-state pattern P-16 documents for
  `read_journal`, hand-rolled here rather than called — confirmed in
  RULINGS.md D-0085/OQ-16 as intended, not a residual bug: `cmd-backlog.sh`
  never calls `read_journal` at all.
- **Unreadable is refused, not rendered around.** `jq -e . "$GOV/design.json"
  >/dev/null 2>&1 || die "..."` (`:36-37`) and the identical shape for
  `tasks.json` (`:95-96`) and `sprints.json` (`:104-105`). `die` is
  `lib/cli.sh:199` → `_cli_refuse` → **exit 2**, matching P-16/OQ-16's
  correction: the exit code the stale `lib.sh` header used to claim (1) was
  wrong; 2 is confirmed intended (`RULINGS.md:38`).
- **The `--features` `tasks.json` guard is present, not missing.** `:44-48`
  reads `if [ -f "$GOV/tasks.json" ]; then jq -e . ... || die "$(journal_unreadable ...)"`
  before assigning `TASKSJSON`. This is the fix RULINGS.md D-0085 records
  ("the `--features` bare `cat` gains the corrupt-journal guard") — the guard
  is *in place* in this checkout, not a gap to rediscover. `journal_unreadable`
  (`lib.sh:145-148`) is the one shared wording both branches use.
- **Ranked vs. never-ranked is a hard partition, not a sort key.** jq splits
  on `.rank != null` and renders the ranked half numbered
  (`\(.key + 1). ...`, `:72`/`:138`) and the unranked half with a bare `- `
  prefix and no number (`:76`/`:142`) — so an absent priority decision can
  never be misread as a numbered one. `sort_by(.id)` orders the unranked half
  (`:71`/`:137`), which is a stable string sort over the id, not creation
  order.
- **Accepted and superseded work never appears.** `.status != "accepted" and
  .status != "superseded"` (`:135`, and implicitly features carry no such
  filter because `design.json` features don't get a terminal status the same
  way — verified there is no analogous status filter in the features branch,
  §"Open questions").
- **Description truncation is a UX contract, not a validation.** `fdesc`/
  `desc_line` (`:62-69`, `:124-131`) render at most one continuation line,
  truncated to 150 chars with an ellipsis and the exact flag name to see the
  rest, unless `--full` is set. `I-0048`'s comment (`:18-22`) states why:
  User was asked to rank 22 tasks off a view with no rationale in it.
- **Sprint annotation is live-only.** `sprint_of` (`:111-115`) only
  considers sprints whose `.status` is `ratified` or `proposed`; a
  `complete` sprint's membership does not annotate the task row, matching
  `backlog-tests.sh`'s explicit assertion (`:107-110`).

### `views` — the one generated-view refresh, and its one failure mode

`views_render` (`cmd-views.sh:24-35`) calls `render_views`
(`lib/journal.sh:29-124`, out of this module's file list but load-bearing
here) and then inspects `GRAPH_BUILD_FAILED`, a variable `render_views` sets
as a side effect. `render_views` itself treats a graph-build failure as
**non-fatal** (P-14) because it also runs on every governance write and a
stale graph must never abort a transaction (`journal.sh:104-106`). `views
render` is the one place that turns the same fact into a hard failure,
because — per the comment at `cmd-views.sh:26-28` and `journal.sh:103-107` —
an explicit "regenerate now" request that silently leaves the thing stale is
a lie the write path is allowed to tell but a report is not.

The mechanism is worth being precise about because it is easy to port wrong:
`emit()` (`lib/cli.sh:159-174`) **exits the process**. So
`views_render`'s body —

```sh
if [ "${GRAPH_BUILD_FAILED:-0}" -ne 0 ]; then
  row_fail governance-graph "..."
  emit "views regenerated, but the governance graph is STALE."
fi
row_pass views "..."
emit "views regenerated"
```

— never reaches the second `row_pass`/`emit` pair when the graph failed: the
first `emit` inside the `if` exits first, with `CLI_OK=0` (set by `row_fail`,
`lib/cli.sh:83`), so the process exits 1 carrying only the `governance-graph`
FAIL row. `fail-closed-tests.sh:73-90` drives this for real (parks
`cmd-graph.sh`, asserts nonzero rc and that the message names "graph") rather
than asserting it structurally, so the TS port must reproduce the **early
return**, not just the two possible summary strings.

### `memory` — the one append `scrumux` owns because the caller can't write it itself

`memory_add` (`cmd-memory.sh:6-35`) appends one dated, attributed block to
`governance/validator-memory.md`. The whole point (comment `:24-29`, `T-0124`
per `scrumux-memory-tests.sh:1-9`) is that the issue-validator agent is
read-only by design (D-0007) and cannot write its own memory, so `scrumux`
does it on the agent's behalf — one append, one lock-free `>>`. It is
deliberately **not** routed through `write_json`: this file is prose with a
`## Run <date> — <by>` heading convention, not a `{entries:[...]}` journal,
and is outside `SEALED_JOURNALS` (comment `:24-29`).

Two refusals gate the append and both are strict, not loose:
- `--by` is mandatory (`:13`) — "so a reader can tell whose memory this is."
- ~~The target file must **already exist and be non-empty** (`:22-23`) — "this
  command appends to an existing memory, it does not create one." Confirmed
  by `scrumux-memory-tests.sh:57-65`: moving the file aside makes the next
  `memory add` fail with a message containing "does not exist."~~
  **SUPERSEDED by D-0089 (2026-08-31).** The ABSENT case is reversed: `memory
  add` now creates `governance/validator-memory.md` with its header and
  appends normally, reporting `created … and appended …`. The measured
  consequence of the old behaviour, found by the Phase 1c operator sandbox:
  `harness deploy` seeds no memory file and the verb refused to make one, so
  the `memory` noun was unreachable on every fresh deploy until a person
  hand-wrote the file — a wall in front of the USER, which is the Prime
  Article. User on the comment that called the refusal deliberate: it wasn't
  his, and a comment asserting deliberateness is not a ruling.
  **The EMPTY-but-present case still refuses**, and now says why: a zero-byte
  file existed and has lost its header, so writing a new one over it would
  silently decide that whatever was there did not matter. Assertions:
  `scrumux-memory-tests.sh` §4b (creation) and §4c (the surviving refusal).

The block itself comes from `--file PATH` or, absent that, from stdin
(`:14-19`) — the same shape `cmd-secret.sh` uses for the secret value, for
the same reason (keep the payload out of argv).

**A misplaced comment.** Lines 37-45 of `cmd-memory.sh` are a full
doc-comment for a function called `env_drop`, describing dropping one
`NAME=` line from `.env` "with no temp file" and naming the historical
`grep -v` exit-1-on-no-match bug. **`env_drop` is not defined in this file —
it lives in `cmd-secret.sh:6-18`, verbatim as described.** The comment is
orphaned: it documents `cmd-secret.sh` machinery from inside `cmd-memory.sh`,
between `memory_add` and `memory_verbs`, with nothing in between calling it.
Flagged under Open questions — it is a documentation hazard for the port,
not a behavior.

### `health` — registration only; the runner it feeds is a different module

`health_add` (`cmd-health.sh:6-29`) is the **entire** verb surface of this
noun: it validates four flags and appends one entry to
`governance/repo-health.json` via `write_json` (`lib.sh:300-...`, its own
module). **The check runner — `run_health_checks`, which is where OQ-15's
TIMEOUT-vs-`lint` ordering lives — is `lib.sh:696-753`, invoked by `task
verify` (`cmd-task.sh:1001`), not by anything in `cmd-health.sh`.** This
module never runs a check; it only shapes what a later run will see. That
distinction matters for the port: OQ-15's fix belongs to the `lib.sh` /
`task`-verb module's inspection, not this one, and this doc covers it only as
context for what `health_add`'s fields are *for*.

- `--name` and `--command` are mandatory (`:15-16`).
- `--type` is validated against a closed enum — `build|test|run|lint|other` —
  **or empty** (`:17`); an empty `--type` is accepted and the field is
  **omitted from the JSON entirely** (`:22`, `+ (if $t=="" then {} else
  {type:$t} end)`). The consumer (`lib.sh:740`) defaults a missing `type` to
  `"test"` at *read* time via `// "test"` in the jq TSV projection —
  registration time and execution time disagree about where the default
  lives.
- `--timeout` is validated as "empty, or all-digits" (`:18`); an accepted
  empty value is likewise omitted from the JSON (`:24`) and defaulted to
  `120` at execution time (`lib.sh:740`, `((.timeout_seconds // 120) |
  tostring)`).
- `seal_bootstrap` (`journal.sh:149-...`) runs after the write — the
  once-per-repo baseline for a never-sealed repo; the per-write reseal is
  `write_json`'s own concern (`reseal_one`), noted explicitly in the comment
  at `:25-27`.

### `secret` — write-only credential storage; there is no read-back verb by design

`secret_impl` (`cmd-secret.sh:20-149`) implements `set`/`list`/`remove` behind
one function, dispatched by `secret_run` (`:177-188`), which also validates
arg counts before calling in (`list` takes none, `remove` takes exactly one).
This is the module P-45 names directly (`cmd-secret.sh:26`): **there is no
`scrumux secret get`**, on purpose, and `list` prints only names, byte counts
and an 8-hex-char sha256 prefix (`:62-67`), never a value.

Load-bearing mechanisms:
- **`get`/`show`/`read`/`cat`/`print`/`reveal` as a NAME are refused**, not
  stored (`:76-79`) — otherwise `scrumux secret get FOO` (the first thing
  anyone types) would silently create a secret literally named `get`.
  `hook-secret-tests.sh` is a different module (the `block-secret-reads`
  hook); the assertion for *this* refusal is `scrumux-secret-tests.sh:40-42`.
- **Gitignore before write, always** (`:106-115`, comment `:106-108`
  underlines the ordering is deliberately load-bearing: reversing it opens a
  window where the secret is on disk and committable).
- **A tracked `.env` refuses the write outright** (`:119-123`) — gitignore
  does not retroactively cover a file git already follows, so writing would
  ship the secret on the next commit. Gated on `command -v git` **and** the
  target being inside a git repo (`git -C "$ROOT" rev-parse --git-dir`); see
  Open questions for what happens when git is absent.
- **`env_drop`** (`:6-18`) rewrites `.env` minus one `NAME=` or `export
  NAME=` line, with **no temp file** — `: > "$1"` truncates in place, then
  appends the survivors back. The comment (`:6-12`) documents the two bugs
  this replaced: `grep -v` exits 1 when it drops the *last* remaining line
  (breaking a `&&`-chained `mv`), and the temp-file version left an
  ungitignored `.env.tmp.NNN` holding every other secret in the repo.
  `chmod 600` is applied twice — before the truncation write and again after
  the append (`:15`, `:17`) — belt-and-suspenders, not two different
  permissions.
- **PK-13 (D-0085), confirmed done in Phase 1a**: every `NAME=` match is
  `^(export[[:space:]]+)?NAME=`, in `env_drop` (`:13`), in `list`'s parse
  loop (`:58-59`), in `remove`'s existence check (`:87`), and in `set`'s
  replace-detection (`:128`) — so a `.env` written with the common `export
  NAME=value` idiom is recognized, normalized to its bare name on `list`, and
  fully replaced (not duplicated) on `set`. `scrumux-secret-tests.sh:87-117`
  drives all three verbs against an export-prefixed line.
- **The value may arrive on stdin (preferred) or as argv (accepted, with a
  loud warning).** `:93-98`: if no positional VALUE, refuse a TTY stdin
  outright (`[ -t 0 ] && die ...`) and otherwise `cat` stdin. If a VALUE
  *was* given as argv, the write still proceeds — `FROM_ARGV=1` only drives a
  post-write `NOTE:` telling the operator their shell history and this
  transcript now carry the value, with the exact `history -d` scrub command
  (`:141-143`). Nothing refuses the argv form.
- **A trailing-newline-only check for embedded newlines** (`:100-104`): the
  comment explains *why* it is not `case $VAL in *"$(printf '\n')"*` — command
  substitution strips trailing newlines, so that naive pattern would match
  every string (`*""*`) — and uses `wc -l` instead. A value with an embedded
  (non-trailing) newline is refused with a message pointing at storing a
  *path* to a multi-line credential instead.
- **Name validation is POSIX-glob, not regex**: `case "$NAME" in
  *[!A-Za-z0-9_]*|[0-9]*) die ...` (`:81-83`) — any non-alnum-underscore
  character anywhere, or a leading digit. `!` inside `[...]` is shell glob
  negation, not ERE `^`. See Open questions.

---

## Deliberate looseness

| # | What | File:line | Philosophy mapping |
|---|---|---|---|
| L1 | Absent `tasks.json`/`design.json`/`sprints.json` renders a friendly empty-state message at rc 0; the check is hand-rolled, not routed through `read_journal` | `cmd-backlog.sh:32,88-91,102-107` | **P-16** (tri-state read pattern) / **OQ-16**, confirmed intended (RULINGS.md D-0085) |
| L2 | A corrupt journal `die`s at **exit 2**, not the exit 1 a stale `lib.sh` comment used to claim | `cmd-backlog.sh:36-37,95-96,104-105` | **OQ-16**, confirmed intended — "backlog exit 2 confirmed intended" (RULINGS.md:38) |
| L3 | `views render`'s graph-build failure is fatal to the *command* even though the same failure is non-fatal on every write path that also calls `render_views` | `cmd-views.sh:24-35`; `journal.sh:103-107` | **P-14** (graph build failure non-fatal on write path and fatal for `views render` — this module IS the "fatal for views render" half) |
| L4 | `health_add` accepts an empty `--type`/`--timeout` and omits the key from the JSON rather than writing the resolved default; the default (`"test"`, `120`) is applied later, at execution time, by a different module | `cmd-health.sh:17-24`; consumed at `lib.sh:740` | NEW — not found registered under a P-# item; the two-default-sites split (write time silent, read time explicit) is worth a register entry |
| L5 | `--timeout` accepts `0` — the glob only excludes non-digit characters, not the value `0` or an unreasonably large one | `cmd-health.sh:18` | NEW |
| L6 | `secret set NAME VALUE` (argv form) is accepted and written, not refused — only a post-write warning names the exposure and gives a manual scrub command | `cmd-secret.sh:93-98,141-143` | NEW |
| L7 | The git-tracked-`.env` refusal only fires when `git` is on `PATH` and the target is inside a git repo; absent either, the write proceeds with no equivalent check | `cmd-secret.sh:119-123` | NEW |
| L8 | `secret list` on a repo with no `.env` yet is a normal empty state (`'no .env yet — nothing stored'`, rc via `emit ""`), not a refusal | `cmd-secret.sh:51` | NEW — same "absence is normal" shape as **P-16**/**P-19**, but for a plain file, not a journal; no existing P-# covers non-journal file absence |
| L9 | `memory add`'s `--file`/stdin duality accepts either with no cross-check; only one of them is consulted (file wins if given) and there is no `--file -` stdin escape hatch documented | `cmd-memory.sh:14-19` | Not loose in the sense of a permissive validation — noted here only because it pairs with L6's stdin-preference pattern; not philosophy-mapped |

Not counted as looseness (strictness, listed here only to keep the census
honest — the module refuses more than it permits):
`memory_add` requires the target file to be non-empty IF IT EXISTS
(`cmd-memory.sh`, the empty-but-present arm; the pre-exist half was reversed
by D-0089 — see the `memory` section above); `--by` is mandatory (`:13`); an
empty block is refused (`:20`); `secret`'s name validation refuses non-identifier names and
`get`/`show`/etc reserved words (`:76-83`); embedded newlines in a secret
value are refused (`:100-104`); an already-tracked `.env` refuses the write
(`:119-123`, when detectable — see L7); an unknown flag/verb on any of the
five nouns refuses via `die_usage` at exit 2.

---

## Simplify/perf

**BEHAVIOR-PRESERVING**
- `cmd-secret.sh` shells out to `shasum -a 256` (twice: `list`'s loop and
  `set`'s single fingerprint, `:62-64,137-138`) and `wc -c`/`wc -l` (byte
  length, newline count, `:63,102,138`) once per secret touched. A TS port
  computes sha256 with `node:crypto` and byte length with
  `Buffer.byteLength(val, 'utf8')` in-process — same algorithm, same 8-hex
  prefix, same numeric output, zero subprocess spawns. Falls under the
  plan's blanket "no subprocess jq/shasum/awk" sanction.
- `cmd-backlog.sh` validates each journal with `jq -e . file >/dev/null` and
  then, on success, re-reads the same file a second time (`cat` into
  `TASKSJSON`/`SPRINTS`, or directly re-opened by the big `jq -r` pipeline
  for `tasks.json`/`design.json` itself). A TS port does one `readFile` +
  `JSON.parse` per journal, where the `try/catch` around `JSON.parse` *is*
  the validity check — one parse instead of two.
- `env_drop`'s `grep -vE ... "$1"` plus the truncate-then-append rewrite
  (`cmd-secret.sh:13-17`) becomes an in-memory `.env`-line filter followed by
  one write — same result (no temp file, same `chmod 600` timing), fewer
  processes. The double `chmod 600` (`:15` and `:17`) can collapse to one
  call after the final write with no observable difference — mode 600
  either way, and nothing reads the file between the two calls today.
- `cmd-backlog.sh`'s `frow`/`fdesc` (features) and `row`/`desc_line` (tasks)
  are near-duplicate jq functions producing the same "id [status] title
  (annotation)" plus optional continuation-line shape. A TS port can share
  one row-renderer parameterized by the id/title/annotation fields, provided
  the two output strings stay byte-identical to what the two jq functions
  produce today (verified against `backlog-tests.sh`'s literal `grep -q`
  assertions on both).

**OBSERVABLE (proposal only — User rules)**
- Write the *resolved* `type`/`timeout_seconds` into `repo-health.json` at
  registration time (`cmd-health.sh:20-24`) instead of omitting the key and
  letting `run_health_checks` default it later (`lib.sh:740`). What an
  operator would see change: `governance/repo-health.json` would always
  carry an explicit `"type":"test"` / `"timeout_seconds":120` for a check
  registered without those flags, instead of the key being absent — visible
  to anyone reading the journal directly or via `records check`, and it
  removes the two-default-sites split noted as L4. No refusal changes; this
  is a write-shape change, not a new validation.
- Stop accepting `secret set NAME VALUE` (the argv form) and require stdin
  unconditionally. What an operator would see change: a command that
  succeeds today (with a `NOTE:` warning about shell history) would instead
  be refused with a usage message pointing at the stdin form. This is
  flagged as OBSERVABLE and proposal-only because it is a **new refusal**,
  not a behavior-preserving rewrite — it must not be applied by default per
  the "no silent tightening" rule; it is surfaced here because L6 is a
  security-adjacent looseness User may want to close rather than port
  as-is.

---

## Open questions

1. **Misplaced doc-comment.** `cmd-memory.sh:37-45` documents `env_drop`,
   which is defined in `cmd-secret.sh:6-18`, not in this file. Nothing calls
   an `env_drop` from `cmd-memory.sh`. Is this a copy-paste artifact from
   when the two nouns were being split out of a monolithic script (both
   comments reference the same historical `grep -v` bug), safe to drop on
   port, or does it point at a planned-and-abandoned feature (e.g. `memory`
   once managed its own `.env`-shaped file)? The port should not carry the
   orphaned comment forward attached to `memory_add` regardless.

2. **Features branch has no terminal-status filter analogous to
   `.status != "accepted" and .status != "superseded"`.** `backlog_list`'s
   task branch filters those two statuses out (`cmd-backlog.sh:135`); the
   features branch (`:49-78`) filters nothing by status — every feature in
   `design.json` renders, ranked or not. Is a feature's lack of a terminal
   "done" status the reason (features don't get accepted/superseded the way
   tasks do), or is this an asymmetry nobody has hit yet because no feature
   has reached a state where it would matter? `backlog-tests.sh` never
   exercises a features-noun analog of accepted-task exclusion (`:59-60` is
   task-only).

3. **POSIX shell glob vs. JS RegExp — two sites, same hazard class as OQ-8.**
   `cmd-secret.sh:82`: `case "$NAME" in *[!A-Za-z0-9_]*|[0-9]*)` and
   `cmd-health.sh:18`: `case "$TIMEOUT" in ''|*[!0-9]*)`. Both use shell glob
   character-class negation (`[!...]`), not ERE/PCRE negation (`[^...]`).
   The equivalent JS is straightforward (`/[^A-Za-z0-9_]/`,
   `/[^0-9]/`), but it is a translation, not a drop-in — get it wrong (e.g.
   forget the leading-digit alternation `[0-9]*` is a *separate* clause,
   ORed, not ANDed with the character-class test) and a name like `9FOO`
   would be silently accepted where bash refuses it.

4. **Byte-length vs. code-unit-length for secret values.** `cmd-secret.sh`
   reports `$LEN bytes` via `wc -c` (`:63,138`) — a true byte count for
   whatever encoding the terminal/locale produced. A TS port must use
   `Buffer.byteLength(val, 'utf8')`, not `val.length` (UTF-16 code units) —
   for a value containing multi-byte UTF-8 characters (a credential is
   usually ASCII, but nothing enforces that), `.length` would under-report
   and the operator-visible byte count would silently stop matching what
   `.env` actually holds on disk.

5. **jq string truncation is codepoint-indexed; JS `.slice` is UTF-16-unit-
   indexed.** `cmd-backlog.sh:67,129`: `($d | gsub("\n"; " "))[0:150]`. For a
   description containing any astral-plane character (rare for a task
   description, not impossible — an emoji in a title is a real thing this
   codebase has not excluded), jq's `[0:150]` and a naive JS `.slice(0,150)`
   can cut at different points or split a surrogate pair. Use
   `Array.from(str).slice(0,150).join('')` or an explicit codepoint-aware
   truncation to match jq's semantics exactly.

6. **`env_drop`'s grep failure and "no match" are the same code path.**
   `cmd-secret.sh:13`: `_rest=$(grep -vE "..." "$1" 2>/dev/null) || _rest=''`.
   Both "grep found nothing to keep" (exit 1, the intended case) and "grep
   could not read the file" (a different failure) fall through to the same
   `_rest=''`. Every current call site guards file-existence/readability
   before calling `env_drop`, so this may never fire on an actual read
   error in practice — but a TS port replacing `grep` with in-memory
   filtering removes the ambiguity for free (a failed `readFile` throws
   distinctly from "matched nothing"), so this is worth confirming is not
   silently relied upon anywhere before deciding it needs no equivalent
   swallow.

7. **`views render`'s success path is unreachable code once the graph
   fails, and that is invisible from reading `views_render` top to bottom**
   without knowing `emit()` exits. A TS port that treats the function as
   "run some checks, then always report" (the natural reading of the literal
   control flow) will double-report or reach the `row_pass`/`emit "views
   regenerated"` tail after already having failed — get the early-exit
   semantics of `emit()` wrong in one place and this module's one genuinely
   branchy verb silently stops being branchy. See Intent §`views` for the
   traced mechanism; flagging here because it is the sharpest hazard in the
   module and easy to miss on a skim.

8. **`--timeout` and `--type` presence-vs-default split (L4)** is
   unregistered in PHILOSOPHY.md. Is the write-time omission + read-time
   default an intentional "the journal only records what was explicitly
   asked for" stance (i.e. `repo-health.json` as a diff of operator intent,
   not resolved config), or an oversight where the default should have been
   baked in at `write_json` time the way `--type`'s enum validation already
   is? This determines whether L4's OBSERVABLE proposal above is worth
   raising to User at all.
