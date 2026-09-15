# Module inspection — cli-core

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

**Files:** `.claude/scripts/scrumux`, `.claude/scripts/lib/cli.sh`,
`.claude/scripts/lib/ts-owns.sh`. Read in full, line by line, against the
tree as of 2026-08-31 (harness `HEAD` at the top of this session).

---

## Intent

`scrumux` is the single entry point (`scrumux <noun> <verb> [--json]
[args...]`) that replaced eleven standalone scripts. It is deliberately thin
— argv handling, dispatch, and nothing else — and `lib/cli.sh` is where every
cross-cutting concern (the `--json` envelope, the exit rule, the error shape,
the result vocabulary) is written exactly once (`scrumux:11-17`). `ts-owns.sh`
is the one place a verb's implementation moves from bash to TypeScript.

**Boot order matters and is itself part of the contract.** `scrumux:57-59`
resolves `$0` through a symlink chain (T-0149, `:51-56`) to find
`SCRIPTS0`, then sources `lib.sh` **before** `lib/cli.sh`. `lib.sh` defines
its own `die()` at `lib.sh:75` (`exit 1`, prose only) and immediately uses it
to guard on `jq` at `lib.sh:77`. `lib/cli.sh:199-200` **redefines** `die` and
adds `die_usage`, both routing through `_cli_refuse` (exit 2, JSON-capable).
Between those two sourcing lines, any failure is bound to the *first*
`die` — this is the exact mechanism behind PHILOSOPHY.md P-02's measured
result that a missing `jq` exits **1**, not 2: the CLI's own exit-code
doctrine (`scrumux:26-28`: 0/1/2) is not yet installed when the guard that
needs it fires. A TS port that "installs the exit rule first" changes this
observably (see Simplify/perf and Open Questions).

**The registry is a single derived source of truth.** `NOUNS`
(`scrumux:70-92`) is a pipe-delimited heredoc; `noun_known()` (`:94`) and
`module_of()` (`:95`) derive everything else from it — verbs themselves are
*not* listed here, each noun module answers `<noun>_verbs` so they exist in
exactly one place (`:68-69`). `load_noun()` (`:101-105`) sources exactly one
module file per invocation — not all nineteen — both for cost (`status
session` fires on every `SessionStart`) and for isolation (a syntax error in
`cmd-secret.sh` must not be able to take down `task new`, `:98-100`).

**`usage_top`'s noun column is computed, not hardcoded** (`:117-134`): a
literal column width silently truncated the `exception` noun's gloss once,
and the app's own surface reader parses this table by splitting on runs of
spaces, so the bug was invisible to a human and load-bearing for the control
plane (`:118-125`).

**`--json` is a global flag, stripped once, before any noun sees argv**
(`:150-177`). The rotate loop (`:166-177`) preserves argument order and
supports every position — leading, mid-argv, trailing — because a surface
that only recognizes some positions is a surface people get wrong (`:152-155`,
tested at `cli-shape-tests.sh:222-227`). `--` ends the stripping and is
itself dropped, which is the escape hatch for a governance record whose
*value* is literally the string `--json` (`:156-165`,
`scrumux log new --title X --did -- --json`). The rebuild is done with `set --`
(the shell's own positional-parameter rotation), never string concatenation,
because a `--rationale` value routinely contains newlines (`:163-165`).

**`help`/`version` are dispatcher-level, not nouns, and exit before the
envelope machinery is engaged** (`:181-194`). `scrumux help`, `scrumux help
<noun>` and `scrumux version` print prose via `cat`/`printf` directly to
stdout and `exit 0` — they never call `emit`, so under `--json` they still
print plain text, not a JSON object (see Deliberate looseness).

**Dispatch proper** (`:196-248`): an unknown noun exits 2 with prose to
stderr plus the top usage (`:196-200`) — this is the one refusal in the file
that does *not* go through `_cli_refuse`, because it fires before `cli_init`
has been called and before a noun context exists to name. A noun with no verb
loads the noun (for its usage text), then calls `cli_init` and `die_usage`
(`:204-209`) — deliberately no default verb, "a command that guesses is a
command that is sometimes wrong about what you asked for" (`:208`).

**The flip** (`:215-236`, `ts-owns.sh` entire): sits *after* noun/verb are
resolved and *before* `CLI_ARGV` is captured, specifically so the TS side
parses its own argv untouched, and so every internal caller that names
`scrumux`'s literal path (SessionStart, repo-health, `render_views`) routes
through this one line without needing to know a port exists (`scrumux:220-226`).
`ts_owns()` resolution order, first match wins (`ts-owns.sh:1-19`, `:24-56`):

1. `SCRUMUX_IMPL=bash|ts` — hard override, outranks everything, drives the
   differential harness (`:27-30`).
2. `SCRUMUX_TS_VERBS_OFF=1` — no-redeploy emergency rollback (`:32`).
3. `SCRUMUX_TS_VERBS` — explicit env list, for testing one verb (`:34`).
4. `.claude/scrumux-ts-verbs` — a per-repo file, comments stripped with
   `sed 's/#.*//'`, newlines flattened to commas (`:35-37`).
5. `TS_VERBS_DEFAULT` — compiled-in list, empty today (`:22`, `:38`).

A verb key is `"<noun> <verb>"` or bare `"<noun>"` (`:18`), matched with
`grep -qxF` against the comma/whitespace-split list (`:41-43`) — **exact
match on the whole key**, no prefix or glob behavior. Even a matched verb
must still find the compiled TS bundle (`ts_dist_path`, `:58`, derived from
`SCRIPTS0` — where the *code* is — never from `ROOT`, where the *records*
are, `:50-52`) and a `node` on `PATH` (`:54`) before it actually flips
(`:53-55`) — a rollout lever must fail *back* to bash, never fail the
command (`:47-48`).

**`ts_exec` hands off and never returns** (`:60-66`). `exec` replaces the
running process image, so `scrumux`'s own `trap 'rm -rf "$CLI_TMP"' EXIT`
(`cli.sh:62`) **never fires** for a flipped invocation — the trap is
attached to the process `exec` is about to replace. `ts_exec` therefore
removes `CLI_TMP` itself, immediately before the `exec` (`:64`), and
`cli-shape-tests.sh:257-268` measures this directly: three flipped
invocations, temp-dir count before and after, asserted equal — not just
grepped for.

**The envelope** (`cli.sh:158-213`): `_row` (`:81-95`) is the one row
renderer, tier-vocabulary in, `{name, ok, tier, detail}` out via a `jq -nc`
subprocess per row, appended to `$CLI_ROWS` (ndjson). `ok` is *derived* from
tier (`:83`: only `fail` sets `_r_ok=false` and flips `CLI_OK=0`) and `_row`
**always returns 0** (`:94`) regardless of tier — emitting a row can never
itself fail the calling function (PHILOSOPHY P-01). `emit` (`:159-177`)
slurps the three ndjson spool files (`$CLI_ROWS`/`$CLI_DATA`/`$CLI_EXTRA`)
into one `jq -n` invocation producing the `scrumux.cli/1` object, and exits
with the derived code. `capture_report` (`:146-156`) is the seam for report
verbs whose whole output *is* their prose (`status session`, `status
sprint`): it flips `CLI_JSON` off for the duration, captures stdout, and
throws stderr away (`2>/dev/null`, `:150`) — this is PHILOSOPHY P-53. The
refusal path (`_cli_refuse`, `:184-198`) is the single writer of
`error:{kind, message}`, `kind` being exactly `usage` or `refused`
(asserted at `cli-shape-tests.sh:213`). `cli_finish` (`:205-213`) is the
dispatcher's safety net — a module that returns without calling `emit`
still gets one (PHILOSOPHY P-03), explicitly "never a licence" (`:203`).

---

## Deliberate looseness

- **P-01** — advisories (`warn`/`tell`/`note`) never move `CLI_OK`/exit;
  `_row` always returns 0 regardless of tier. `cli.sh:81-95`.
- **P-02** — `status session`'s "always exits 0" guarantee is narrower than
  it looks: a missing `jq` exits **1** (not 2, not 0) because `lib.sh`'s
  original `die()` (`lib.sh:75`, sourced and invoked at `:77`) fires before
  `lib/cli.sh` redefines `die` at `cli.sh:199`. This is a direct artifact of
  cli-core's two-stage sourcing order (`scrumux:58-59`). Argv errors (an
  unknown noun/verb) correctly exit 2 via `cli.sh`'s `die_usage`.
- **P-03** — `cli_finish` is a safety net, never a licence to skip `emit`.
  `cli.sh:202-213`; invoked at `scrumux:250-252`.
- **P-53** — `capture_report` discards a captured report's stderr under
  `--json` (`cli.sh:150`, `2>/dev/null`), while the same jq error would
  print in human mode. `--json` is the lossier output mode for this module.
- **OQ-20** (open, not settled) — the general question of whether a
  diagnostic suppressed under `--json` (this module has two instances:
  `capture_report`'s discarded stderr, and `_cli_refuse`'s single-shot
  refusal object) should land in the envelope rather than nowhere. Not
  fixed here; carried to Open Questions below.
- **NEW** — `help`/`version` bypass the JSON envelope entirely, even with
  `--json` set. `scrumux --json help`, `scrumux help --json` and `scrumux
  version --json` all print raw prose to stdout and `exit 0`
  (`scrumux:181-193`) rather than a `{schema:"scrumux.cli/1", ...}` object.
  Nothing in `cli-shape-tests.sh`'s envelope-case list (`:71-83`) covers
  `help` or `version` — the envelope contract as tested applies only to noun
  verbs. Candidate for the register: is "every verb takes `--json`"
  (`scrumux:137-138`, the help text's own claim) meant to include these two
  dispatcher-level commands, or are they exempt by design?
- **NEW** — the global `--json` rotate consumes the *first* bare `--json`
  token found anywhere before a `--`, silently, with no way to tell
  afterward that a stripped token existed. This is intentional per
  `scrumux:150-155`, but it is unqualified: nothing distinguishes "no
  `--json` in argv" from "one was there and got removed" for a caller that
  cares. Not a defect — the CLI's `--json` boolean is exactly what a caller
  should observe — flagged only because a TS port with a different argv
  library (e.g. one that errors on repeated/unknown flags) could tighten
  this without anyone noticing the widening it removes.
- **NEW** — `ts_owns` fails back to bash **silently** when a verb is
  nominally flipped but the compiled bundle is missing or `node` is absent
  (`ts-owns.sh:53-55`). No row, no stderr line, no signal of any kind that a
  configured flip did not take effect — bash runs exactly as if the verb
  were never listed. Deliberate per the inline comment ("a rollout lever
  must fail BACK to bash, never fail the command", `:47-48`), but the
  silence itself is not discussed. Candidate for the register.
- **NEW** — `emit()` prints **nothing** in human mode when called with an
  empty summary string (`cli.sh:173-175`: `elif [ -n "$_e_summary" ]`). A
  verb that emits with `emit ""` produces zero stdout lines even though a
  real, structured result exists (it is still on `$CLI_ROWS`/`$CLI_DATA`).
  Correction (validation pass 2026-08-31): live callers DO exist and the
  silence is a deliberate idiom for "the report already said everything" —
  `cmd-backlog.sh:179-180`, `cmd-secret.sh:51,148`, `cmd-graph.sh:620-672`
  (several), `cmd-task.sh:386`. The rows/data still travel under `--json`,
  which is what the app reads. Candidate for the register as deliberate.

---

## Simplify/perf

**BEHAVIOR-PRESERVING:**

- **One in-memory row/data/extra accumulator instead of three ndjson spool
  files.** `cli.sh:57-65` creates a whole `mktemp -d` directory purely to
  hold `rows.ndjson`/`data.ndjson`/`extra.ndjson`, appended to by `_row`,
  `data()`, `extra()` and slurped back with `--slurpfile` at `emit` time
  (`:166-172`). In TS this is a plain array/object built up in memory; the
  final envelope's field values, field order and row order are identical.
  This is exactly the "no spool files" simplification named in this
  module's assigned scope.
- **No subprocess `jq` per row.** `_row` (`cli.sh:84`) shells out to
  `jq -nc` once per emitted row; `emit` shells out to `jq -n` once more with
  three `--slurpfile`s. A TS implementation builds the same object shape
  directly — same keys, same types, same values — with zero subprocess
  spawns. Per the A-jqformat spike (PHILOSOPHY.md P-49 note; Companion
  documents), the only place `jq .`'s output cannot be trivially reproduced
  is number literal preservation, which does not arise here since every
  field `_row` writes is a string or a `jq`-derived boolean, not a passed-
  through number.
- **The `--json` rotate loop as a single-pass argv filter.** `scrumux:166-177`
  is already O(n) shell; the TS equivalent (strip the first `--json` not
  preceded by `--`, respecting `--` as a terminator that is itself dropped)
  is the same algorithm with no subprocess involvement. Purely a language
  change, not a behavior change.
- **The noun registry as a compiled structure, not a parsed heredoc.**
  `NOUNS` (`scrumux:70-92`) is walked with `cut`/`grep`/a `while read` loop
  (`:94-95`, `:127-134`) on every invocation. A TS port compiles this once
  (module load) into whatever table drives noun lookup and the `help`
  column layout — same content, same column-width derivation logic (longest
  noun name), zero forking.
- **`load_noun`'s single-module-sourcing discipline carries over as a
  lookup table, not an eager import-everything.** The reason it exists —
  isolation and per-invocation cost, `scrumux:98-100` — still applies in a
  compiled bundle only in the "cost" half (all modules are compiled in
  regardless), but the *dispatch* can still resolve one handler function
  without executing the others' top-level code, if noun modules are written
  to avoid side effects at import time. Preserve the visible behavior (a
  request for noun `X` never runs noun `Y`'s code) even though the
  mechanism (file sourcing vs. property lookup) changes.

**OBSERVABLE** (proposal only — User rules):

- **Wrap `help`/`version` in the same `scrumux.cli/1` envelope under
  `--json`.** What an operator/caller would see change: `scrumux help
  --json` currently prints the plain-text noun table; this would instead
  print a JSON object (nouns and their glosses under `.data`, `ok:true`,
  `exit:0`). Any script currently `grep`-ing the human-readable help output
  under `--json` would break. Makes the CLI's own claim
  ("Every verb takes --json and emits exactly ONE object", `scrumux:137-138`)
  literally true of `help`/`version` too, which today it is not.
- **Emit a `note`/`tell` row (or a stderr line) when `ts_owns` matches a
  verb but falls back to bash because the bundle is missing or `node` is
  absent.** What an operator would see change: today, a repo whose
  `.claude/scrumux-ts-verbs` names a verb that never got a bundle deployed
  runs that verb via bash with zero indication anything was configured
  differently; this would add a visible line (human mode) or a `tell` row
  (`--json`) naming "TS flip configured for `<noun> <verb>` but no bundle at
  `<path>` / no node on PATH — ran via bash". Would not change any exit
  code (still an advisory tier).
- **Make a missing-`jq` bootstrap failure exit 2 instead of 1**, matching
  the CLI's own stated exit-code doctrine ("2: the command could not run at
  all", `scrumux:28`) rather than inheriting `lib.sh`'s pre-CLI `die`
  (exit 1). What an operator would see change: `jq` absent from `PATH`
  today reports rc=1 ("the assertion did not hold" — a real answer that
  does not exist); this would change it to rc=2. This is precisely the kind
  of thing PHILOSOPHY.md P-02 warns must not be tightened without a ruling,
  named here as the proposal it would take.
- ~~Make `emit()` fall back to a default summary line in human mode when
  the caller passes an empty summary.~~ **REFUTED by validation
  (2026-08-31): do not do this.** The empty-summary call is a deliberate,
  widely-used idiom for commands whose printed report already said
  everything; a default summary inside `emit()` would regress at least 8
  files' worth of already-correct output. Kept struck-through so the port
  does not re-derive the proposal.

---

## Open questions

- **OQ-20 carries directly into this module.** Two of this module's own
  mechanisms (`capture_report`'s discarded stderr at `cli.sh:150`;
  `_cli_refuse` producing a single refusal object with no room for a
  secondary diagnostic) are the general case OQ-20 asks about. Not
  resolved here; the port reproduces both as-is pending a ruling.
- **`help`/`version` and the envelope — genuinely undecided, not just
  unfixed.** No PHILOSOPHY.md entry addresses this and no test asserts
  either way. Needs a ruling before Phase 4 rather than being inferred:
  `scrumux:181-194`.
- **Is `ts-owns.sh` itself ever a TS-port target, or is it permanently
  bash?** It is the mechanism that *decides whether to leave bash*, so by
  construction it must run before any TS code exists in the request path —
  the same reasoning that keeps `readonly-sh` bash-only and
  dependency-free (`scrumux:37-41`). Not stated explicitly anywhere for
  `ts-owns.sh`. If it is permanently bash, the port plan should say so
  rather than leave it implicit, because "port `cli-core`" could otherwise
  be misread as including it.
- **`ts_owns`'s per-repo file format is undocumented outside its own
  comment.** `.claude/scrumux-ts-verbs`: `#`-comment stripped, one entry
  per line, flattened to a comma list (`ts-owns.sh:35-37`). No test file
  covers a malformed line, a line with trailing whitespace before the
  comment marker, or CRLF line endings (a Windows editor artifact, which
  the port's whole purpose is to run correctly under). `sed 's/#.*//'`
  strips *everything* after a `#` including inside what might be intended
  as a quoted value — there's no quoting concept in this format at all.
  Worth a hazard note if Phase 7 ever builds a `scrumux wall` or `scrumux
  flip`-style write verb that edits this file, since the read side has no
  escaping to preserve.
- **No test exercises the `--` passthrough / literal-`--json`-value escape
  hatch.** `scrumux:156-165` documents and implements it; grepping
  `tests/` for `-- --json` or `passthru` finds nothing. Not a looseness by
  itself (the mechanism is simple and its logic mirrors POSIX `getopt`
  convention) but it is untested code in the exact file this port most
  needs to get byte-for-byte right, and a TS argv library swapped in
  without checking this case specifically could drop it. **TS-port
  hazard**, not just a documentation gap.
- **`CLI_ARGV`'s line-based encoding drops empty-string arguments from the
  *recorded* argv, though the actual dispatch still receives them.**
  `scrumux:238`: `printf '%s\n' "$@" | jq -R -s 'split("\n") | map(select(length > 0))'`.
  An argument that is literally the empty string `""` becomes a blank line
  in the `printf` stream and is filtered out by `select(length > 0)` — so
  `.argv` in the emitted envelope silently omits it, even though `"$@"`
  passed to `eval "${NOUN}_run \"\$VERB\" \"\$@\""` (`:248`) still carries
  it. **TS-port hazard:** a TS implementation building `argv` directly from
  `process.argv`/a parsed array has no equivalent line-splitting step and
  would naturally *not* drop the empty string — which is more correct but
  is an observable divergence in what `.argv` contains for any caller that
  ever passes an explicit empty value (a `--foo ''` construction). Needs a
  ruling on whether this is P-16-style "the header states the contract
  wrong, the code is the spec" (reproduce the drop) or a candidate
  OBSERVABLE fix.
- **Symlink resolution (`scrumux:51-57`) has no direct TS equivalent to
  port, but its *consumer* (`ts_owns`/`ts_exec`) depends on it having
  resolved correctly.** `ts_dist_path` (`ts-owns.sh:58`) derives the bundle
  path from `SCRIPTS0`, which comes from this resolution. If a future
  packaging change breaks the symlink-resolving prologue for one script
  (regression-tested today at `tests/lib-scripts-tests.sh:302-329`, which
  asserts the prologue is byte-identical across every consumer, and at
  `:190-209`, which drives a real single-file `PATH` symlink and asserts a
  negative control against the pre-T-0149 prologue), the failure mode for a
  flipped verb is not a crash — it is `ts_owns` returning 1 because
  `ts_dist_path` no longer resolves to a real file (`ts-owns.sh:53`), so
  the verb silently runs via bash. Same silent-fallback shape as the "NEW"
  looseness above, worth keeping in mind together.
- **`_row`'s JSON key order (`name, ok, tier, detail`, `cli.sh:85`) and
  `jq -nc`'s exact compact-serialization bytes are not proven to matter to
  any consumer**, but the differential harness's stated method (byte
  comparison, per the A-jqformat spike referenced in PHILOSOPHY.md
  Companion documents) means a TS serializer that reorders keys or
  reformats whitespace could register as a divergence even though no
  `.checks[]` consumer in this codebase does textual matching (all
  consumption seen in the test suites uses `jq -e`/`jq -r` structural
  access, not string comparison). Flagged so the differential harness's
  comparison mode for this module is decided explicitly rather than
  discovered as a false-positive flood.
