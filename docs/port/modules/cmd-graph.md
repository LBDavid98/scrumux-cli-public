# Module inspection — `cmd-graph`

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

**Source:** `.claude/scripts/lib/cmd-graph.sh` (698 lines, one exported
noun: `graph`, two domains `code` and `gov`).
**Scope of this doc:** the **bash side** — dispatch, the shell↔Python
bridge (env vars, heredocs, temp files), the freshness/staleness checks,
`bearing_render`'s TSV→text rendering, and the `--json` envelope this
module builds. The graph *algorithms* (`agents/lib/code_graph.py`,
`agents/lib/governance_graph.py`) are a separate shard's territory; they
are read here only where their exit codes, stdout/stderr shape or
embedded-heredoc error text are directly load-bearing on this file's
contract.
**Tests read in full:** `tests/graph-cli-tests.sh` (354 lines — dispatch,
D-0043 staleness, reader-never-rebuilds, fresh-repo self-heal, data/code
root separation), `tests/graph-wiring-tests.sh` (178 lines — agent-facing
docs name real subcommands), `tests/bearing-tests.sh` (410 lines —
`graph gov bearing`'s CLI section, §6–9). Also grepped for graph-relevant
assertions: `tests/fail-closed-tests.sh` (site 3: the module itself
removed → `views render` refuses), `tests/cli-shape-tests.sh` (`graph gov
stats`, `graph code stats`, `graph code find repo_root` in the
whole-surface envelope suite — `graph code build` is **not** in that
list, see Open Questions). `tests/code-graph-tests.sh` and
`tests/governance-graph-tests.sh` test the Python libraries directly and
are the other shard's contract.
**Read alongside:** `docs/port/PHILOSOPHY.md` P-14, P-20 (module-specific);
`RULINGS.md` D-0085 (spike verdicts: both graphs port to
web-tree-sitter, Python leaves the CLI entirely).

---

## Intent

### The reader/builder/check split, and why it exists

The file's own header (`:11-54`) states the design directly and it checks
out against the code: three kinds of surface over two graphs.

- **Readers** (`callers|callees|symbols|find|near|stats` for code;
  `provenance|inbound|outbound|impact|orphans|dangling|stats` for gov)
  answer from the on-disk index only. No tree-sitter, no rebuild, ever.
- **Builders** (`build`) are the only surfaces with a toolchain dependency
  (tree-sitter grammars for code; none for gov — `:383` calls the gov
  builder "stdlib-only … always available").
- **The freshness check** (`index`) is the one place the two policies
  meet: rebuild when possible, report when not, refuse only when there is
  truly no answer available (`graph_code_index`, `:290-350`; the gov
  self-heal inside `graph_gov_py`, `:378-421`).

This split is why `graph_code_read` (`:85-205`) imports
`agents.lib.code_graph` **before** touching the index — the docstring at
`:95-97` explains the import used to sit above dispatch, so every query
refused when grammars were merely absent even though a valid index sat on
disk. The import failing now means the module itself is missing
(`:97-102`, `die`-equivalent exit 2), not that indexing tools are absent.

### Two separate Python bridges, not one

`graph_code_read`/`graph_code_build` (`:85-283`) and `graph_gov_py`
(`:353-548`) are independent heredoc-fed `python3 -` invocations, each
sourcing a different library. There is no shared "run python" helper —
every call site repeats `PYTHONPATH="$GRAPH_HARNESS" "$GRAPH_PY" - "$@"
<<'PYEOF' … PYEOF`. `GRAPH_PY` resolves to `$GRAPH_HARNESS/.venv/bin/python`
if executable, else bare `python3` on `PATH` (`:61-63`); `graph_need_python`
(`:76-79`) is the one guard, called once per public entry point
(`graph_code_read`, `graph_code_build`, `graph_gov_py`), and its `die` call
lands correctly at exit 2 because `scrumux` sources `lib.sh` then
`lib/cli.sh` **before** any noun module runs (`scrumux:57-58`), unlike the
`status session` anomaly in PHILOSOPHY P-02 where a guard fires before
`cli.sh` redefines `die`.

### `CODE_GRAPH_DATA_ROOT` vs `CODE_GRAPH_TREE_ROOT` — code location is not
data location, and the split is deliberately asymmetric between reader and
builder

`GRAPH_HARNESS` is resolved once (`:61`, `cd "$SCRIPTS/../.."`) as "the
tree the scripts live in." The **reader** always uses it as
`CODE_GRAPH_TREE_ROOT` (`:87`) — it can only ever describe the checkout it
is running from. The **builder** takes an explicit `--repo` and lets it
override *both* roots together (`:213-231`, comment at `:215-220`): that is
what lets `harness deploy` index a target repo from a harness checkout that
has the grammars, while the reader in that same target repo (which has no
grammars) reads what was built for it. `CODE_GRAPH_DATA_ROOT` always tracks
`$ROOT`/`GOV_ROOT` (lib.sh's data/code split, restated at `:57-60`),
confirmed live at `tests/graph-cli-tests.sh:329-347` (index lands under a
sandboxed `GOV_ROOT`, the file count in the build report still reflects the
real harness tree).

### Provenance is stamped, never withheld (P-20)

Every code-graph answer carries `age = cg.index_age(g, tree_root)`
(`:129`), rendered as one stderr line in human mode (`:135-144`) or folded
into `.data.provenance` under `GRAPH_JSON=1` (`:149-150`). The four-outcome
freshness table (current / stale+rebuild / stale+TELL / no-index+FAIL) is
`graph_code_index` (`:290-350`) and matches PHILOSOPHY P-20 exactly at
current line numbers: the TELL is `:344-349`, "no index and no builder" is
the one FAIL, at `:307`.

Two things worth citing precisely because a port will be tempted to
"clean them up":

- **The `stale = false` string comparison is deliberately exact**
  (`:326-329`, comment inline): `[ "$_gci_stale" = false ]`, not `!=
  true`. The prior `!= true` passed an empty or null stale flag from a
  half-read index (CLI-8). A TS port using `age.stale === false` rather
  than `!age.stale` must preserve this — `undefined`/`null` from a
  malformed payload must not read as "current."
- **The freshness check computes its answer by re-invoking the reader as
  a subprocess** (`:311`, `GRAPH_JSON=1 graph_code_read stats 2>/dev/null
  | jq -r '.provenance | …'`) rather than calling `index_age` directly.
  This is a real "shell to python to shell" round trip — spawn a second
  interpreter, serialize to JSON, deserialize with `jq`, tab-split with
  `cut`. In TS this collapses to one function call; see Simplify/perf.

### `bearing_render` is the one place TSV crosses the process boundary

`graph_gov_py bearing` (`:447-508`) emits three-letter-prefixed TSV rows
(`P`/`R`/`S`) rather than the prose most other gov subcommands print
directly, specifically so `bearing_render` (`:677-697`) — running in
**this shell**, not Python — can call `ref_resolve`, "the ONE
supersession-aware renderer" (`:679-681`, T-0082). The comment at
`:642-646` names the alternative rejected: re-deriving supersession in
Python would be a second encoding of the exact thing T-0082 collapsed into
one. `bearing-tests.sh:307-308` is the load-bearing assertion: the record
text must say `SUPERSEDED by D-9003`, proving the render path, not the
query path, resolved it.

The dispatch around it (`graph_gov_run`'s `bearing)` arm, `:641-663`) uses
a **temp file**, not a pipe, specifically because `sh` has no `pipefail`
and a bearing set that came back empty because the query silently failed
would be worse than no answer (`:648-652`). The temp file lives under
`$CLI_TMP`, which the dispatcher already cleans up on exit — the comment
notes this deliberately avoids installing a second `EXIT` trap, which
would silently replace the caller's (`sh` allows exactly one).

### `I-0118`: an unknown flag is refused, never swallowed as a path

`bearing`'s argument loop inside the Python heredoc (`:461-479`) treats
`--task` and `--file` as recognized flags (`--file` is accepted as a
synonym for a bare path — four historical order-drafters wrote it that
way, `:456-459`), and refuses **any other** leading-dash token rather than
appending it to the path list. This replaced a bug where `bearing
--nonsense X` silently read `--nonsense` as a path and printed `path
absent --nonsense` above the real answer.

**There is exactly one enforcement site, and it is in Python, not the
shell.** `graph_gov_run`'s `bearing)` dispatch arm (`:641-663`) does no
argv validation of its own — it passes `"$@"` straight through to
`graph_gov_py bearing "$@"`. The refusal that `graph-cli-tests.sh:130-132`
exercises through the CLI is answered entirely by the arg loop at
`:461-479`. A port that adds a second, shell- or TS-dispatcher-level
pre-filter "for defense in depth" would be inventing a check this system
does not have; keep the one site.

### No LLM anywhere in this path (D-0001)

Stated at `:54` and asserted by `bearing-tests.sh:400-403` with a direct
grep over both `agents/lib/governance_graph.py` and the `bearing` line in
this file for `gateway|generate(|model`. Both graphs answer from recorded
structure only.

---

## Deliberate looseness

| # | What is loose | Where | Maps to |
|---|---|---|---|
| L1 | A code-graph query never rebuilds and never refuses on staleness — it answers and stamps the answer with how old it is | `:126-156` (provenance stamp), `graph_code_index` `:290-350` | **P-20**, verbatim |
| L2 | Stale-with-no-builder is a TELL, never a FAIL — every reader still answers | `:344-349` | **P-20** |
| L3 | `graph gov build`/`index` self-heals a completely absent `governance/` directory rather than refusing (the FIRST thing a freshly deployed repo does) | `:398-415`, comment `:399-405` citing D-0043 and I-0002 | **NEW** — same D-0043/D-0044 ruling family as P-20, applied to the governance graph; PHILOSOPHY.md has no dedicated entry for the gov-graph side. Recommend folding this in as **P-20a** or a standalone entry when the register is next appended. |
| L4 | A gov-graph index built by an **older library version** (schema mismatch) is silently rebuilt rather than served stale or refused — mtimes cannot see a shape change with no accompanying journal write | `:416-421`, comment `:416-418` citing T-0153/I-0063 | **NEW** — same self-heal family as L3/P-20, distinct trigger (schema, not mtime). Confirmed by `bearing-tests.sh:346-355`. |
| L5 | `repair journal`'s post-repair machinery check runs `harness verify`, and this module's `views render` dependency is the flip side: a graph-build failure is silently absorbed on the *implicit* write path (journal.sh) but fails hard through this module's *explicit* `graph code build`/`index` | journal.sh side is `:100-123` (not this file); this file's explicit-request side is `graph_code_build`'s error handling `:247-268` and the `build)` dispatch arm `:617-620` | **P-14** — the asymmetry is the design; this file implements the "explicit request must not report success it did not achieve" half. |

---

## Simplify/perf

### BEHAVIOR-PRESERVING

- **Eliminate both Python subprocess bridges entirely.** Per
  `RULINGS.md` D-0085 (spike C, adopted), `agents/lib/code_graph.py`
  and `agents/lib/governance_graph.py` port to TS with `web-tree-sitter`
  loaded from in-memory grammar bytes, reproducing the code index
  byte-identically. Once that lands, this module's entire
  heredoc-embedding mechanism (`graph_code_read`'s and
  `graph_code_build`'s `python3 - <<'PYEOF' … PYEOF`, `graph_gov_py`'s
  equivalent), the `GRAPH_PY`/`.venv` resolution (`:61-63`), and
  `graph_need_python` (`:76-79`) disappear — replaced by direct TS
  function calls into the ported modules. **Preserve exactly:** every
  stdout/stderr string these heredocs currently print (the no-index
  refusal `:113-118`, the corrupt-index message `:124-125`, the
  provenance line format `:135-144`, the build report format `:270-277`,
  the gov-side error strings `:360-364`, `:412-414`, `:467-469`,
  `:476-479`, `:483-484`, `:516-517`, `:524-525`) — these are Article-5
  contract text, not incidental logging.
- **Collapse the freshness check's subprocess-round-trip.** `:311-313`
  spawns a second `python3` invocation with `GRAPH_JSON=1`, pipes its
  stdout through `jq -r`, then `cut -f1`/`cut -f2` to extract two fields.
  Once the reader is a direct TS function call, `graph_code_index`
  becomes one call to whatever `index_age`-equivalent function the ported
  code-graph module exposes, no serialize/deserialize round trip. Must
  preserve the exact `stale === false` semantics (not merely falsy) —
  see Intent.
- **Collapse `bearing`'s TSV intermediate format**, once both the query
  (`gg.bearing`) and the renderer (`ref_resolve`, `bearing_render`) live
  in the same language: no more `P\t…`/`R\t…`/`S\t…` line protocol, no
  temp file, no `IFS=$(printf '\t')` field-splitting loop (`:683-696`).
  A direct data structure passed from query to renderer removes the
  `sh`-has-no-`pipefail` workaround (`:648-652`) entirely, since a thrown
  exception replaces the `> "$BOUT" || { row_fail …; }` pattern. **Must
  preserve:** the exact rendered line formats asserted at
  `bearing-tests.sh:303-306` (`path changes src/alpha.sh`, `D-9001
  [changes src/alpha.sh via T-9001] …`) and the summary line format
  (`bearing: N decision(s)/issue(s) over M path(s)`, `:507`,
  `bearing-tests.sh:309-310`).
- **`_short()`'s commit-truncation helper** (`:130-133`, `c[:8] if c and
  not c.startswith("unknown") else "no git commit"`) is a pure function
  with no I/O — port verbatim as a one-line TS helper, no behavior
  change possible or intended.
- **One process boundary, not per-call flag marshaling.** Currently every
  call site re-derives `PYTHONPATH`, `CODE_GRAPH_DATA_ROOT`,
  `CODE_GRAPH_TREE_ROOT` or `GOV_GRAPH_ROOT` as environment variables
  passed into a fresh interpreter (`:87`, `:232`, `:355`). A TS port
  passes these as ordinary function arguments. Behavior-preserving as
  long as the same root-resolution rules (Intent, above) are reproduced.

### OBSERVABLE (proposal only — User rules)

- **`graph gov <verb> --json` currently returns only unstructured text**
  (`.data.lines: string[]`, via `data_lines` at `graph_gov_run:664-670`),
  while `graph code <verb> --json` returns structured fields
  (`.data.provenance`, `.data.coverage`, plus `.data.lines`) because the
  Python side builds that object itself when `GRAPH_JSON=1`. Measured:
  `graph gov stats --json` on an empty index returns `{"data":{"lines":
  ["nodes 0: ","edges 0: ","dangling 0"]}}` — a machine consumer has to
  parse `"nodes 0: "` as text even under `--json`. **What an operator
  would see change if unified:** `graph gov stats --json` would gain
  typed fields (e.g. `.data.nodes`, `.data.edges`, `.data.dangling` as
  numbers) alongside or instead of `.data.lines`; every other `graph gov`
  JSON verb (`provenance`, `inbound`, `outbound`, `impact`, `orphans`,
  `dangling`, `bearing`) would gain equivalent structure. This is a
  genuine capability gap, not a bug in the current contract, and closing
  it changes the on-disk JSON shape every existing `--json` consumer of
  `graph gov` sees.
- **Give `graph code build`'s stderr suppression under `--json` the same
  treatment `graph gov`'s build/index arm already has** (see Open
  Questions — this may be closer to a defect than a proposal; listed here
  too because the fix, if User rules it one, is squarely
  behavior-changing for `--json` consumers).

---

## Open questions

### OQ-cg-1 · `graph code build --json` emits the build report AND the JSON envelope on the same stdout stream, unlike every other verb in this module

**Measured**, not inferred — reproduced against this repo:

```
$ GOV_ROOT=<scratch> .claude/scripts/scrumux graph code build --json
graph code: 110 files, 659 symbols, 696 edges -> <scratch>/governance/code-graph.json
  indexed: bash=104, python=6
  NOT INDEXED: 9 javascript file(s) — tree_sitter_javascript is not installed …
  NOT INDEXED: 14 typescript file(s) — tree_sitter_typescript is not installed …
  other files: 337 (no language mapped)
{
  "schema": "scrumux.cli/1",
  ...
  "data": {}
}
$ ... | jq -s 'length'
jq: parse error: Invalid numeric literal at line 1, column 6
```

`scrumux`'s own header states the contract: *"Every verb takes --json and
emits exactly ONE object on stdout."* This verb does not. The cause is
visible at the two call sites that differ:

- `graph_code_index` (`:290-350`) **captures** the builder's output —
  `_gci_out=$(graph_code_build 2>&1)` (`:297`, `:335`) — then prints it
  through `say "$_gci_out"` (`:301`, `:339`), which `lib/cli.sh:112-113`
  suppresses under `--json`.
- The `build)` arm of `graph_code_run` (`:617-620`) calls
  `graph_code_build "$@"` **directly, uncaptured**. `graph_code_build`'s
  own Python (`:269-277`) `print()`s its report unconditionally — it has
  no `GRAPH_JSON` check at all, unlike the reader's Python (`:149-156`).

**Not verified as deliberate.** No comment addresses `build`'s output
mode, and this exact case (`graph code build --json`) is absent from both
`tests/graph-cli-tests.sh` and the whole-surface envelope suite
`tests/cli-shape-tests.sh:85-96`, which tests `graph gov stats` and
`graph code stats`/`find` but not `graph code build`.

**Question for User:** is this a defect worth a `decide` + bash-first fix
in Phase 1a (the same route P-11 names for other pre-port bash
corrections), or does the port reproduce the malformed-JSON-stream
behavior for parity? Recommend the former, since no port note anywhere
says "TS may loosen the envelope contract for this one verb," and
reproducing a broken JSON stream on purpose is an unusual thing to commit
to. Behavior ported as bash currently has it until ruled.

### OQ-cg-2 · A code-graph reader's failure exits 2 under `--json` and 1 in human mode — for the identical underlying condition

**Measured:**

```
$ GOV_ROOT=<empty scratch> .claude/scripts/scrumux graph code stats
$ echo $?
1
$ GOV_ROOT=<empty scratch> .claude/scripts/scrumux graph code stats --json
$ echo $?
2
```

Human mode: `graph_code_read "$_c" "$@" || { row_fail code-graph "…"; emit
""; }` (`:630`) — `row_fail` sets `CLI_OK=0`, `emit` exits 1. This is "the
assertion did not hold": the query ran, the answer is no-index.

`--json` mode: `_out=$(GRAPH_JSON=1 graph_code_read "$_c" "$@") || { die
"…"; }` (`:625-626`) — `die` is `_cli_refuse refused` (`lib/cli.sh:198`),
exit 2, and `.checks` stays empty (confirmed above: the JSON envelope
carries `"checks": []` and puts the message only in `.error.message`).
Per `lib/cli.sh:42-48`, exit 2 means "nothing was asserted either way" —
but the same failing condition asserted something (a row) one line away
in human mode.

`graph gov`'s equivalent branch (`graph_gov_run`, `:664-672`) does **not**
have this split: both `--json` and human mode use `row_fail` on failure,
exit 1 in both modes. So the asymmetry is (a) between `--json` and human
mode within `graph code`, and (b) between `graph code` and `graph gov`
within the same file's `--json` mode.

**Not verified as deliberate** — no comment discusses why the code-side
JSON failure path uses `die` where the human-mode path and the gov side
both use `row_fail`. **Question for User:** should `graph code`'s
`--json` reader failure be a `row_fail` (exit 1, matching human mode and
matching `graph gov`), or should human mode match `--json` (row_fail
replaced by an unconditional refusal)? Either direction is a visible
exit-code change for existing `--json` consumers. Behavior ported as-is
until ruled.

### OQ-cg-3 · `bearing`'s Python stderr is not suppressed under `--json`; every other gov verb's is

`graph_gov_run`'s `build|index|…|stats)` arm redirects the Python
process's stderr to `/dev/null` specifically in the `cli_is_json` branch
(`:666`, `2>/dev/null`). The `bearing)` arm (`:653-654`) has no such
redirect: `graph_gov_py bearing "$@" > "$BOUT"` sends stdout to the temp
file but leaves stderr connected to the real terminal in both modes. On
success this is invisible (nothing is written to stderr). On a Python-side
failure, `bearing --json` would leak the interpreter's raw stderr to the
terminal outside the JSON object, while `stats --json`'s equivalent
failure stays silent (P-53/OQ-20's "`--json` is the lossier mode" pattern,
but running in the *opposite* direction here — bearing is the *more*
diagnosable one).

**Not verified as deliberate** — this reads as an incidental difference
between two dispatch arms written at different times, not a stated
design. Flagged because OQ-20 in PHILOSOPHY.md raises the general
question of what a suppressed diagnostic should do under `--json`, and
this module has two sites that already disagree with each other, not just
with the general principle. Behavior ported as-is; folds into whatever
general ruling OQ-20 receives.

### OQ-cg-4 · No timeout wraps either Python subprocess in this module

`run_health_checks` (elsewhere in `lib.sh`) wraps checks in
`run_with_timeout`; nothing in `cmd-graph.sh` does the same for
`graph_code_build`, `graph_code_read`, or `graph_gov_py`. A large tree (or
a pathological governance journal) could hang either bridge indefinitely
with no operator-visible bound. **Not verified as intentional or as a
problem that has ever fired** — no comment addresses it either way, and
adding a timeout would be new, observable strictness (a build that
currently completes slowly would instead be killed), so this is
surfaced as a question, not a recommendation. TS-port hazard: a
subprocess-elimination port (per Simplify/perf) makes this moot for the
reader/query paths, but a tree-sitter parse driven directly in the TS
process could still run unbounded on a pathological file, and the
question of whether to bound it is the same question, just moved.

### OQ-cg-5 · TS-port hazards specific to this file's mechanics (not separately ruled elsewhere)

- **`.venv/bin/python` vs bare `python3` fallback** (`:62-63`) disappears
  entirely once Python leaves the CLI (D-0085). Nothing to port; noted so
  a porter does not go looking for a TS equivalent of a resolution rule
  that no longer applies to anything.
- **`GRAPH_JSON=1` as an env-var switch read by the embedded Python**
  (`:149`, `:311`) is itself part of the mechanism being eliminated — a TS
  port's equivalent "give me structured output" signal is an ordinary
  function parameter, not an environment variable. Not a divergence to
  rule on, just a mechanical translation note.
- **`bearing_render`'s tab-splitting** (`_dl_n` pattern aside — actually
  `br_tab=$(printf '\t')`, `:684`) is POSIX-`sh`-specific quoting to get a
  literal tab into `IFS`; irrelevant once the P/R/S rows are a typed data
  structure rather than text, but the **row kinds' semantics**
  (`P`=path, `R`=record, `S`=summary; the conditional "also …" suffix
  when a path has more than one bearing task, `:686-690`; `br_t` falling
  back to `"UNRESOLVED — the record named by an edge is gone"` when
  `ref_resolve` finds nothing, `:692`) are the actual contract and must
  reproduce exactly, including the fallback string.
- **`is_stale` hint strings are asserted by `tests/graph-cli-tests.sh:246-270`
  against the live Python module**, not against this shell file — a TS
  port that moves the hint text must keep those assertions passing
  against wherever the text now lives; this file only relays the text,
  it does not own it.
