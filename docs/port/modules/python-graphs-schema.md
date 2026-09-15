# Module inspection — python-graphs-schema

> Pinned at a118eb5 — file:line references resolve against `git show a118eb5:<path>`; the tree may have moved.

Covers `agents/lib/code_graph.py` (656 lines), `agents/lib/governance_graph.py`
(571 lines), `agents/lib/schema_check.py` (233 lines), and
`agents/lib/design.py` (33 lines) — the four Python files still alive at
Phase 5, the phase that deletes Python from the CLI entirely.

Read in full, every line, against `docs/port/PHILOSOPHY.md`, `RULINGS.md`
(D-0085/D-0086), `docs/port/spikes/C-tree-sitter.md`, and the six test suites
whose names or `PYTHONPATH=... python3 -m agents.lib...` invocations touch
this module: `tests/code-graph-tests.sh`, `tests/governance-graph-tests.sh`,
`tests/governance-graph-query-tests.sh`, `tests/graph-wiring-tests.sh`,
`tests/graph-cli-tests.sh`, `tests/bearing-tests.sh`, plus the schema-sweep
assertions inside `tests/records-check-tests.sh` (`§2`, "the schema sweep is
a module") and `tests/harness-tests.sh` (deploy-payload roster). Plan
authority: `/Users/user/.claude/plans/velvet-yawning-crab.md`, "Graph &
Python exit" and the Phase 5 gate line.

---

## Intent

**Two graphs and one schema reader, all pure functions over on-disk state,
with an LLM banned from every path (D-0001) — asserted by all three modules'
own docstrings and mechanically re-checked by every test suite here via
`grep -qiE 'generate\(|gateway|openai|anthropic'` (`code-graph-tests.sh:332`,
`governance-graph-tests.sh:159`, `governance-graph-query-tests.sh:131`).**

### `code_graph.py` — what is here and what calls what

`build()` (`:274-347`) answers "what is here and what calls what" by parsing
this repo's own source with tree-sitter rather than by grep, because grep
cannot resolve `. lib.sh` back to a caller graph and D-0009/D-0042 measured
that a shell-heavy repo (72% of this one) makes a Python-only indexer miss
most of the CLI. It is deliberately **two node kinds and two edge kinds**
(`:10-16`): `file`/`symbol` nodes, `defines`/`calls` edges — not a general
AST store, because a general store answers "is this used" only through a
second query the callers here never wanted (docstring `:1-27`).

**The reader/builder split is the single most load-bearing structural fact
in this file, and it is stated as the reason `tree_sitter` is imported
inside a function rather than at module scope** (`:36-46`): importing it at
module scope made *loading* the module require the grammars, so a repo with
a perfectly good `governance/code-graph.json` on disk could not answer
`callers`, `callees`, `symbols`, `find`, `near` or `stats` — every one of
those is a pure function over the JSON file (`:551-593`) and needs no parser.
Only `build()` needs `_load_grammars()` (`:144-178`), called from inside
`build()` (`:301`). **A TS port that hoists a tree-sitter import to module
top-level in the query file silently reintroduces the exact defect this
split fixes.**

**The language registry is data, not a branch** (`:52-138`), and the
docstring explains why in a measured example: encoding D-0042's two-language
measurement as an `if/elif` made a one-time measurement into a permanent
ceiling, and a repo that grew PHP got an index reporting "31 files, 0 parse
errors" with the PHP invisible — "the worst shape a coverage number can
have: a skipped file looked exactly like a file with nothing in it"
(`:56-59`). So `EXTENSION_LANGUAGE`/`SHEBANG_LANGUAGE` name a language whether
or not `GRAMMAR_MODULES` has a dependency for it, and `coverage.skipped`
(`:318-326`, `:446-451`) reports the difference by name. Extensionless shell
(17 of 58 files here) is named by reading the first 128 bytes against five
shebang patterns (`:106-112`, `:199-206`) — never guessed from the directory.

**Call resolution is deliberately, measurably lossy, and the loss is the
point** (`:388-419`): an unfiltered shell parse yields ~4300 coreutils
invocations (docstring `:17-23`), and helper names like `ok`, `bad`, `die`
defined in ~30 test suites turned 241 symbols into 3998 edges before the
same-file-preference rule (`:406-414`) — "complete, and useless." Two
sub-rules the comment states outright and Spike C independently confirmed as
deliberate (`spikes/C-tree-sitter.md` §10 item 5), not merely observed:

- a callee name resolving to **more than one** repo-wide definition, with
  **no same-file candidate**, is **dropped entirely** — the call vanishes
  from the graph (`:413-414`, `local or ([targets[0]] if len(targets)==1 else [])`);
- a callee name resolving to **exactly one** repo-wide definition is
  attributed to it **unconditionally**, even with no same-file match and no
  type information connecting the call site to that definition. `_callee_name`
  for Python keeps only the tail after the last dot (`obj.method()` → `method`,
  `:240`), so a call is matched by bare name only. This is the mirror image
  of the drop rule: **precision-by-uniqueness is a heuristic, not a proof**,
  and a repo that grows a second `method()` anywhere converts a correct edge
  into a dropped one — never into a *wrong* one, because at that point there
  are two candidates and the drop rule fires instead. Flagged here because it
  is exactly the kind of accuracy trade a porter tidies away by "just doing
  the right thing" (recognising the call is ambiguous and resolving it via
  some cleverer scope analysis) without a ruling.

**Two definitions of the same name in one file collapse to one symbol**
(`_walk_tree`, `:364-365`: `symbols[sid] = {...}`, unconditional overwrite),
and the **last one walked wins the `line`** field. `_walk_tree` walks an
explicit LIFO stack (`:358-385`) — not a recursive descent — specifically so
a call is attributed to the innermost *enclosing* definition rather than to
the file (`:356-357`); the traversal order this stack produces is what
decides which of two same-named definitions "wins." Also confirmed
deliberate by Spike C (§10 item 5), not merely present.

**Provenance and freshness are the honesty layer over a reader that never
rebuilds** (`:453-548`, `:592-655`): every graph carries `built_at`,
`built_at_epoch` (a **float**, deliberately — `:476-479`, because truncating
to whole seconds made a source file written at `t=x.9` compare newer than an
`int(x)` index stamp, i.e. every fresh build looked stale against itself),
`commit`, and `dirty`. `is_stale`/`is_stale_graph` compute staleness two
ways — a source file newer than the index, **and** an indexed file no longer
on disk (`:640-654`, `:526-548`) — because a deletion moves no surviving
mtime the walk could see (I-0085, cited at `:541-544` and `:643-646`); the
index's own file list is the only thing that can catch that half. `find`,
`callers`, `callees` etc. all answer from the index unconditionally and
**stamp** the answer with how stale it is, rather than refusing or
rebuilding — this is the same mechanism P-20 documents for the CLI dispatch
layer (`cmd-graph.sh`), but the actual `is_stale`/`index_age` computation
**lives in this module**, so this file is P-20's real origin, not merely its
caller.

**Writes bypass the shared journal writer entirely, and say why twice**
(`write_index`, `:596-609`, and the identical pattern in
`governance_graph.py:400-412`): "Never through write_json's jq path — I-0058:
a filter emitting no output truncates the target to zero bytes." Both index
writers do their own `mkdir -p` (`:608`, `:411`) because a repo that has
never taken a governance write has no `governance/` directory yet, and
`graph code build --repo <plain repo>` used to die with a bare
`FileNotFoundError` on exactly the flag whose purpose is pointing at a repo
that isn't this one. Both are asserted by name in their own test suites
(`code-graph-tests.sh:328-329`, `governance-graph-tests.sh:157-158`,
`grep -qE 'write_json[[:space:]]*\('`, must NOT match).

### `governance_graph.py` — what the records say, traversed

`build()` (`:160-254`) turns every journal entry's `refs`/`supersedes`/
`task`/`feature`/... fields into typed edges — typed **by the field they came
from**, not merely "related" (docstring `:1-22`), because D-0026 held four
issues in decision *text* while `refs.issue` carried one, and I-0023 was put
to User four separate times because nothing pointed at it. Both are cited
as the measured failures the graph exists to make mechanical rather than
memorised.

**A ref that resolves to a real node becomes an edge; a ref that doesn't is
`dangling`, never dropped** (`edge()`, `:191-200`) — this is the D-0026/
I-0023 fix made structural. But the guard that produces `dangling` is
`_ID.fullmatch(target)` (`:195`), and **a `refs` value that is a string but
does not match the id shape at all — a typo, a stray label, anything that
isn't `PREFIX-NNNN` — is silently `continue`d, never appearing in `edges`
*or* `dangling`.** Only a *well-formed* id that fails to resolve is
surfaced. A malformed one is invisible in exactly the way the module's own
docstring says a *dropped* record must not be. This is not addressed by any
comment in the file and is not in the PHILOSOPHY register — flagged as NEW
below, not fixed.

**`bearing()` (`:333-393`) is the file-to-law traversal** (S-0064): given a
path set and an owning task, it walks the `changes`/`reads` file edges every
task order contributes (`order_paths`, `:135-157`), then one hop further
through each touching task's `review`/`log` neighbours (`_BEARING_RELAY`,
`:300`, `_records_around`, `:315-330`) to the decisions and issues that bind
the file. Two things the docstring insists are deliberate and the tests
enforce as negative assertions (`bearing-tests.sh`, I-0070 shape):

- the task being asked about is **dropped as a source** (`:377-378`) — "its
  own refs are what a caller is checking, so returning them would make the
  check vacuous";
- a path's `relation` for a scoped query is read from **that task's own
  order**, never from whichever other task changed the file hardest
  (`:364-368`) — otherwise a file another task edits would read as
  `changes` for an order that lists it read-only, "I-0070, reintroduced."

`_NO_DIFF` (`:83-85`) — the regex that decides whether an `expected_diff`
string means "no edit" — is matched **on the first word only**, and the
docstring states the trade explicitly with measured numbers (`:75-82`): a
whole-string negation scan would need to exist to catch phrasings like
*"source of a rule name; not edited"*, but the same scan would also
misread real edits like *"two lines removed, the guard branch untouched"* as
no-ops. Measured on the live journals: **2 of ~180 distinct values** cost one
missed advisory each under the narrow match; the wide match would cost a
class of missed *changes*, which the docstring calls the worse failure. This
is a genuinely reasoned precision/recall trade, not an oversight — flagged
here so a porter doesn't "improve" it into a whole-string scan.

**`_adjacency()` (`:303-312`) exists purely for performance and says so**:
`inbound()`/`outbound()` each scan the whole edge list, and `bearing()` was
calling the equivalent once per `(path, task)` pair — "on this repo that is
a five-figure scan for an answer the caller wanted in a second." Built once
per `bearing()` call. This is the one place in the module where an
optimisation is explained inline as an optimisation, not a behaviour change
— a clean citation for the Simplify/perf section below.

**Schema versioning is a second, independent freshness axis** (`GRAPH_SCHEMA
= 2`, `:43-51`; `load_index_current`, `:435-460`; `is_stale`, `:463-484`):
an mtime check alone cannot see a *library* change, because after a code
change every journal on disk is *older* than the index, so a naive mtime
check reports "current" the day a new edge kind (T-0153's file nodes) ships,
and a query answers confidently from a graph that structurally cannot hold
the new answer. `is_stale` checks schema **before** dates (`:472-478`); the
CLI's non-index-file path (`cmd-graph.sh:406-416`, read during inspection)
self-heals a missing index the same way `code_graph.py` does. This mechanism
has no PHILOSOPHY.md entry and no decision citation of its own — it is
reasoned entirely from the comment beside it. Flagged as NEW below.

**The `reviews.json`/`R`-prefix/`review`-kind machinery is dead, and its
removal is a *pre-approved, TS-only* divergence — not a bash fix.**
`PROMISES-KEPT-AUDIT.md` PK-11 names `PREFIX_JOURNAL`/`JOURNALS` at
`:31-41`; the panel this served was removed by D-0076 and `reviews.json`
does not exist in this repo (confirmed: no file under `governance/`, no
script under `.claude/scripts` or `.claude/hooks` writes or reads it). The
audit's own disposition is **"KNOWN — pre-approved port divergence,"** and
the plan (`velvet-yawning-crab.md`, "Graph & Python exit") states it in the
same breath as the golden-fixture freeze: *"The dead reviews.json reference
in governance_graph.py: fixed, recorded as an approved divergence."* Two
things worth stating precisely because the audit's citation is narrower than
the actual footprint:

1. **This is *not* in D-0085's Phase-1a bash-first fix list.** That list
   (mirrored in `RULINGS.md`) enumerates thirteen items and `reviews.json`
   is not among them. So bash's `governance_graph.py` is **not** touched —
   there is no point patching a file Phase 5 deletes — and the divergence is
   TS-only, asymmetric between the two implementations by design, not an
   oversight to reconcile.
2. **The dead reference is not confined to the two lines PK-11 cites.** Six
   sites carry `"review"`/`reviews.json`/`"R"`, not two:
   `PREFIX_JOURNAL["R"]` (`:33`), `JOURNALS` (`:37`), `_kind_of`'s
   `"reviews.json": "review"` (`:115`), `provenance()`'s `"reviews": []`
   bucket and `"review": "reviews"` mapping (`:278`, `:281`), `_BEARING_RELAY`
   which walks **through** `review`-kind nodes (`:300`), and `ROOT_KINDS`
   which exempts `review` from ever being reported as an orphan (`:533`). A
   TS port that removes only `PREFIX_JOURNAL`/`JOURNALS` per PK-11's literal
   citation leaves `_kind_of` unreachable dead code and the other four sites
   referencing a kind that can never occur — surfaced here so the fix is
   scoped to the actual footprint, not the two lines audited.
3. **Every test fixture that currently builds `reviews.json` breaks the
   moment this lands**, and that is expected, not a regression to chase:
   `governance-graph-tests.sh` (`R-9001`, `.reviews` assertions at
   `:40-42`, `:79`, `:108-109`), `governance-graph-query-tests.sh` (`R-9001`
   as an authored-root fixture, `:43-44`, `:78-79`, `:108-109`), and
   `bearing-tests.sh` (the relay-hop fixture uses a review/log two-hop
   shape). These three suites `import agents.lib.governance_graph` directly
   and die with Python at Phase 5 regardless; they are not something the TS
   port ports forward as-is — they are retired, and their *intent*
   (SP-before-S prefix ordering, both-direction provenance, the relay hop,
   the negative orphan assertions) needs an equivalent TS suite built
   without the review shape, not a literal translation of the fixture data.

### `schema_check.py` — the deliberate JSON Schema subset

`~80 lines of stdlib` (docstring `:12-20`) understanding exactly seven
keywords (`_KNOWN`, `:37-38`): `type`, `properties`, `required`,
`additionalProperties`, `enum`, `items`, plus the inert `description`,
`$schema`, `title`. This is **P-34** in the register, and the plan
(`velvet-yawning-crab.md`, Phase 5) states the port disposition explicitly:
*"schema_check stays a subset."* Two narrownesses inside the subset, both
load-bearing and both P-34:

- `additionalProperties` is enforced **only when literally `False`**
  (`:92`) — a schema-object value for it (rare in JSON Schema, absent from
  these ten schemas today) is silently ignored, same as `true` or absence.
- A `bool` is explicitly rejected where a `number`/`integer` is wanted
  (`:77-78`), because Python's `bool` is an `int` subtype and would
  otherwise pass `isinstance(x, (int, float))` silently.

`check_journal` returns `[]` — not an error — for a journal file that does
not exist (`:121-122`, **P-35**): a fresh repo has no journals, and absence
is not a finding.

**`OQ-2` is resolved, not open, and the resolution is already live in
bash.** PHILOSOPHY.md's OQ-2 entry (as written) describes
`unsupported_keywords()` as having no caller; `RULINGS.md`'s D-0085 records
*"OQ-2: unsupported_keywords wired into the schema sweep as WARNs"* as one
of the thirteen Phase-1a bash-first fixes, and the code on disk confirms
it shipped: `main()` (`:161-228`) calls `unsupported_keywords()` twice — once
per-schema under `--unsupported` (`:178-188`) for the detail view, and once
to build **one aggregate line** (`:209-226`, *"UNSUPPORTED N keyword(s)
across M schema(s)..."*), never one line per keyword, "measured when this
was wired: 82 across 7 schemas... A detector that fires 82 times on a clean
repo teaches the operator to ignore it" (`:200-208`). `cmd-records.sh:499`
consumes exactly this aggregate line and wraps it in a `w()` (WARN, never
moves the exit code) — confirmed live by `records-check-tests.sh:277-297`,
which asserts the `UNSUPPORTED ` line by name. **The port note is therefore
not "wire it up" but "port the aggregate, not a per-keyword flood," and
port the fact that it never moves the exit code.**

One stale internal reference, cosmetic only: the module docstring
(`:17`) says `unsupported_keywords` is *"what `_UNSUPPORTED` is for,"* but
the actual set is named `_KNOWN` (`:37`) — `_UNSUPPORTED` is not a symbol
anywhere in the file. No behaviour depends on it; listed under Simplify/perf.

**`OQ-3` is genuinely open, and it is this module's open question.**
`PAIRS` (`:144-158`) lists seven journal/schema pairs; `design.json` and its
shipped `.claude/schemas/design.schema.json` are not among them, so epics,
features, stories, surfaces and controls get write-time field validation in
`cmd-epic/feature/story.sh` but no schema sweep ever checks them.
`RULINGS.md` records the disposition as a **design ruling**, not a bash
fix: *"design.json's absence from schema PAIRS is deliberate (polymorphic
journal); per-kind validation is a Phase 5 proposal."* So this module's own
phase is where that proposal is due — carried into Open Questions below,
not resolved here, because resolving it would be exactly the "add a
validation bash doesn't have" move PHILOSOPHY.md's absolute rule forbids
without a ruling.

### `design.py` — what it is, precisely

A 33-line projection: `load_design()` reads `governance/design.json`'s
uniform `{entries:[{kind,...}]}` shape and buckets entries by `kind` into
`{features, stories, surfaces, controls, epics, wireframe_refs}` (`_KINDS`,
`:13-20`). Its own docstring calls it *"the Python twin of lib.sh's
`design_view`"* (`:3-7`) — `.claude/scripts/lib.sh:613-624` confirms a bash
function of that name and purpose exists and is the thing this mirrors.

**A repo-wide grep found zero callers of `load_design` anywhere in this
tree** — no other Python file imports `agents.lib.design`, and no shell
script invokes it via `python3 -m`. It is not registered in any `PAIRS`
table, not used by either graph builder, and not referenced by any test
suite. This observation is stated as a fact from a grep, not as a verdict —
per the standing rule that grep proves absence, never intent, this is
exactly the kind of claim that needs a second look before anyone acts on
it (see Open Questions).

### The freeze-the-golden-indexes requirement, made specific

The plan's exact words: *"Freeze the Python-built `code-graph.json` +
`governance-graph.json` as golden fixtures before deleting Python,"* and the
Phase 5 gate: *"Golden-index comparison vs frozen Python output, exact or
divergence-ruled."* Read against what this inspection found, that requires
capturing, before `agents/lib/*.py` is deleted:

1. **`governance/code-graph.json`** built by the live Python `build()`
   against this repo's own tree at a pinned commit — the artefact the plan
   names directly.
2. **`governance/governance-graph.json`**, same treatment — the second
   artefact the plan names directly. Because of the `reviews.json`
   divergence above, this freeze needs to be **taken and diffed knowingly**:
   the TS output will differ from the frozen Python output in every
   `review`-shaped place (no `R-*` nodes, no `reviews` bucket, no orphan
   exemption for a `review` kind that cannot occur), and the comparison
   tooling needs a rule that accepts exactly that shape of difference and no
   other — "exact or divergence-ruled" as stated, with this as the one ruled
   divergence.
3. **The sandboxed fixture outputs the test suites already build and
   assert against** — `code-graph-tests.sh`'s mini-repo (`scripts/lib.sh`,
   `scripts/alpha`, the `ok()` collision fixture, the Python
   `pkg/core.py`/`pkg/user.py` import pair) and the query results run over
   it (`callers_of`, `symbols_in`, `find_symbol`, `neighbourhood`); and
   `bearing-tests.sh`'s six-task fixture with its `bearing()`/`provenance()`/
   `impact()`/`orphans()` outputs. The plan's language names only the two
   live `governance/*.json` artefacts; these fixture-derived outputs are the
   actual acceptance oracle a TS unit-test suite will assert against, and
   Spike C's own top risk (UTF-16 vs. byte offsets, §9 item 1) specifically
   recommends *"a fixture that contains a non-BMP character above a
   definition"* — which does not exist in the current fixtures and would
   need to be added before the freeze, not after.
4. **Not named by the plan, and worth surfacing rather than assuming
   covered:** `schema_check.py`'s violation-list output. Phase 5's gate
   language ("golden-index comparison") reads as scoped to the two graphs;
   `schema_check` is in the same phase and the same "Python exits" event,
   but nothing says its violation output (over the seven `PAIRS` journals,
   clean and under each of `records-check-tests.sh`'s seeded corruption
   cases) gets an equivalent frozen corpus. Flagged as an open question
   below rather than assumed either way.

---

## Deliberate looseness

Each line maps to a PHILOSOPHY.md item where one exists, or is flagged
**NEW** — a candidate for the register, not yet a bug and not yet ruled.

1. **Schema validator understands seven keywords only; anything else is
   named, never enforced.** `schema_check.py:35-38`. → **P-34.**
2. **`additionalProperties` enforced only when literally `False`; any other
   value is a silent no-op.** `schema_check.py:92`. → **P-34.**
3. **A `bool` is rejected where `number`/`integer` is wanted, explicitly,
   because Python's `bool` is an `int`.** `schema_check.py:77-78`. → **P-34.**
4. **`check_journal` returns `[]`, not an error, for a journal file that
   does not exist.** `schema_check.py:121-122`. → **P-35.**
5. **`unsupported_keywords()` is wired into one aggregate WARN line, never
   a per-keyword flood, and never moves the exit code.**
   `schema_check.py:161-228`; `cmd-records.sh:499`. → **OQ-2, resolved by
   D-0085** — settled behaviour to port, not an open question.
6. **`design.json` is never schema-checked; `PAIRS` omits it on purpose
   because a polymorphic `{kind}`-discriminated journal doesn't fit a
   single-schema sweep.** `schema_check.py:144-158`. → **OQ-3, open** — a
   design ruling this phase is asked to make, not a bash behaviour to
   silently port around.
7. **Call resolution drops an ambiguous cross-file call entirely rather
   than guessing, and resolves an *unambiguous* one unconditionally even
   with zero type information connecting call site to definition.**
   `code_graph.py:404-419`; confirmed deliberate by `spikes/C-tree-sitter.md`
   §10 item 5. → **NEW.**
8. **Two same-named definitions in one file collapse to one symbol; the
   last one walked wins the recorded line.** `code_graph.py:364-365`;
   confirmed deliberate by the same spike citation. → **NEW.**
9. **External/coreutils calls (the ~4300-invocation noise D-0042 measured)
   are dropped from the graph entirely, unconditionally.**
   `code_graph.py:17-23` (docstring), `:395` (`_resolve`), asserted by
   `code-graph-tests.sh:126-127`. → **NEW** (this is the load-bearing
   design choice the whole module is built around, and it has no P-number
   of its own despite P-14/P-20/P-22 all touching this module's
   *consumers*).
10. **A graph reader never rebuilds; every query answers from the on-disk
    index and stamps its own staleness rather than refusing or blocking.**
    `code_graph.py:487-548`, `:632-655`; `governance_graph.py:463-484`. →
    **P-20** — and this module is where the mechanism actually lives, not
    merely where it's invoked.
11. **Derived indexes (`code-graph.json`, `governance-graph.json`) are
    excluded from `SEALED_JOURNALS` and go through neither `write_json`
    nor the backup/reseal machinery — both write directly, by design, citing
    I-0058.** `code_graph.py:596-609`; `governance_graph.py:400-412`. →
    **P-22** (the exclusion) and the direct-write half is its own
    consequence, stated inline at both sites.
12. **A graph build failure is non-fatal on the implicit write-path rebuild
    and fatal on an explicit `graph … build`/`graph … index` request** — the
    asymmetry lives in the CLI/journal layer (`journal.sh:100-123`,
    `cmd-graph.sh` / `cmd-views.sh`), but the `build()` function whose
    failure mode this dispatches on is defined in this module. → **P-14**,
    cross-referenced.
13. **A `refs` value that is a string but does not match the id shape at
    all is silently dropped — not added to `edges`, not added to
    `dangling`.** Only a well-formed-but-nonexistent id is surfaced.
    `governance_graph.py:191-200` (`edge()`), specifically `:195`. → **NEW**
    — no comment in the file addresses this, and it sits directly beside
    the mechanism (`dangling`) built to make exactly this kind of gap
    visible.
14. **`_NO_DIFF` matches the first word only, accepting two known missed
    advisories in exchange for not missing a real edit** — a stated,
    measured precision/recall trade, not an oversight.
    `governance_graph.py:68-85`. → **NEW.**
15. **`bearing()` drops the queried task as its own source, and reads a
    path's relation from that task's own order rather than from whichever
    task changed the file hardest.** `governance_graph.py:333-393`,
    specifically `:364-368`, `:377-378`; asserted by the I-0070 negative
    cases in `bearing-tests.sh`. → **NEW** (S-0064-cited in the docstring
    but not yet a PHILOSOPHY.md entry).
16. **Schema-version mismatch (`GRAPH_SCHEMA`) triggers a silent rebuild —
    written to disk if possible, held in memory only if not — with the
    notice going to stderr and never into a `--json` envelope.**
    `governance_graph.py:43-51`, `:435-460`. → **NEW** — the same shape as
    **P-53** (`capture_report` discards stderr under `--json`) but for a
    different producer; not itself in the register.
17. **The `reviews.json`/`R`-prefix/`review`-kind machinery is dead code
    kept alive in bash on purpose (no point fixing what Phase 5 deletes),
    and is the one place in this module where the TS port is *approved to
    diverge from bash*, not merely to reproduce it.**
    `governance_graph.py:31-41`, `:115`, `:278-281`, `:300`, `:533`. →
    **PK-11**, pre-approved TS-only divergence — the *opposite* disposition
    from every other item on this list, and worth stating plainly so it
    isn't ported by the same "reproduce bash exactly" reflex.
18. **`design.py`'s `load_design()` has no caller anywhere in this
    repository**, by grep. Not classified as a looseness or a defect here —
    see Open Questions; a finding this shaped is exactly the kind the
    working rule on validating findings exists for.

---

## Simplify/perf

**BEHAVIOR-PRESERVING** (safe to apply in the port; same observable output):

- **One parse per file, one build per invocation** — already true of
  `build()` (`code_graph.py:274-347`, `governance_graph.py:160-254`); the
  port should keep this shape rather than re-parsing per query, which the
  reader/builder split already prevents structurally.
- **`_adjacency()` built once per `bearing()` call, not once per
  `(path, task)` pair** (`governance_graph.py:303-312`) — port the
  precomputed neighbour map, not a naive per-pair `inbound()`/`outbound()`
  scan; the source comment already states the perf reasoning and measured
  cost ("a five-figure scan").
- **`_walk_tree`'s `if True:` wrapper is a vestige of its extraction out of
  `build()` and does nothing** (`code_graph.py:355`) — already named
  `PK-12` in `PROMISES-KEPT-AUDIT.md` as a builder simplify item. Drop the
  equivalent no-op control flow in the TS port; zero behaviour change.
- **`schema_check.py`'s module docstring names a symbol, `_UNSUPPORTED`,
  that does not exist** (`:17`, vs. the real `_KNOWN` at `:37`) — a doc-only
  fix, port the comment correctly rather than porting the stale name.
- **Query functions (`callers_of`, `callees_of`, `symbols_in`,
  `find_symbol`, `outbound`, `inbound`) are simple list/set comprehensions
  over `graph["edges"]`/`graph["symbols"]`** (`code_graph.py:554-568`,
  `governance_graph.py:259-264`) — straightforward to port as-is; no
  subprocess, no `jq`, no `awk` anywhere in either graph module (confirmed
  by reading every line), so there is no subprocess-elimination work to do
  here the way there is elsewhere in the port. The one subprocess call in
  scope is `_git()` (`code_graph.py:460-467`, three call sites: `rev-parse
  HEAD`, `status --porcelain`, `rev-list --count`) — keep it a subprocess
  (or an equivalent git library call) with the same silent-empty-string
  failure mode on any `OSError`/non-zero exit (`:465-467`), since
  `_provenance()` and `index_age()` both treat an empty/failed git read as
  "not a git checkout" rather than an error (`:480-481`, `:497-505`).

**OBSERVABLE** (changes visible behaviour; proposal only, User rules):

- **Report the ambiguous-call drop count.** Today an ambiguous cross-file
  call (item 7 above) simply doesn't appear as an edge, with no trace in
  `coverage`. An operator would see a new field — e.g.
  `coverage.ambiguous_calls: N` — appear in `graph code build`'s output,
  counting calls that resolved to more than one same-named definition with
  no local match. This adds visibility, not a new failure: nothing that
  passes today would fail, and nothing that's dropped today would start
  appearing as an edge.
- **Surface malformed refs, not just dangling ones.** Today a `refs` value
  that fails `_ID.fullmatch()` (item 13 above) vanishes with no trace at
  all. An operator would see a new `malformed` list in
  `governance-graph.json`, parallel to `dangling`, naming the source record
  and the field that held an unparseable value. This is additive reporting
  only — it does not make `records check` or any write path refuse
  anything it accepts today.
- **Put the schema-version-rebuild notice into the `--json` envelope.**
  Today `load_index_current`'s rebuild notice (item 16 above) reaches only
  stderr; a `--json` caller of `graph gov …` sees nothing when this fires.
  An operator scripting against `--json` would start seeing a new field (a
  warning row, in the same shape OQ-20's general rule already establishes
  for other suppressed diagnostics) the one time a library upgrade
  triggers a silent rebuild.

---

## Open questions

1. **OQ-3 (carried forward, this module's to answer).** `design.json` is
   never schema-checked (`schema_check.py:144-158`); `RULINGS.md` names
   "per-kind validation" as a Phase 5 proposal. Does Phase 5 (a) leave
   `design.json` outside the schema sweep exactly as bash does — the safe,
   no-tightening default — or (b) add per-`kind` validation as a *ruled*
   change, with its own `decide` record and `APPROVED-DIVERGENCE` marker
   the way PK-11 got one? Not resolved here on purpose: resolving it would
   be adding a validation bash does not have, without a ruling.

2. **Golden-fixture scope gap: does `schema_check.py` get a frozen
   comparison corpus too?** The plan names `code-graph.json` and
   `governance-graph.json` explicitly for the golden-fixture freeze;
   `schema_check.py` exits with Python in the same phase and has no named
   equivalent. If the TS schema reader is meant to be checked byte-for-byte
   against Python's violation-list output (the way the graphs are), that
   corpus — the seven `PAIRS` journals clean, plus each of
   `records-check-tests.sh`'s seeded corruption cases (`§1`, items 1-8) —
   needs capturing before Python is deleted, same as the graphs.

3. **`design.py`'s `load_design()` has no caller found by grep.** Three
   readings, and this inspection cannot distinguish them from the tree
   alone (the same shape as OQ-2's three readings before D-0085 settled
   it): (a) a library function written ahead of a caller that never
   arrived; (b) a caller that existed and was deleted; (c) intended to be
   called via `python3 -m` or similar and simply isn't yet. **This is
   exactly the kind of claim ("nothing calls this") that the standing rule
   on validating findings exists for** — grep proves absence, never intent,
   and a second look should confirm there is no non-obvious caller (a
   skill, a doc-generation step, an agent prompt referencing it by path)
   before Phase 5 either ports it or drops it. Recommend: does the port (a)
   port `design.py` unchanged as dead-but-present code, matching how
   `unsupported_keywords()` sat unwired for however long it did before
   D-0085 wired it; or (b) confirm no caller exists anywhere (including
   outside this repo, since `agents/lib` is also importable by the
   LangGraph product agents the plan's Phase 5 line explicitly carves out
   — *"LangGraph product agents keep Python; not CLI, not deployed"*) and
   drop it from the TS port scope entirely?

4. **`reviews.json` divergence footprint (item 17 above): six sites, not
   two.** PK-11 cites `PREFIX_JOURNAL`/`JOURNALS` at `:31-41`. Confirm the
   TS port's removal is scoped to all six sites identified in Intent
   (`_kind_of`, `provenance()`'s bucket, `_BEARING_RELAY`, `ROOT_KINDS`) and
   not just the two the audit line-numbered, and confirm the three bash
   test suites that build a `reviews.json` fixture
   (`governance-graph-tests.sh`, `governance-graph-query-tests.sh`,
   `bearing-tests.sh`) are retired rather than translated literally, since
   translating their fixtures would silently re-import the dead shape this
   divergence exists to remove.

5. **TS-port hazard — UTF-16 vs. byte offsets (highest-likelihood, silent
   corruption class).** `code_graph.py` slices symbol/callee text with
   Python byte offsets (`_node_text`, `:217-218`, `src[node.start_byte:
   node.end_byte]` over `path.read_bytes()`, `:337`). `web-tree-sitter`'s
   `parse()` takes a **string, never bytes** (Spike C §3), and
   `node.startIndex`/`endIndex` are **UTF-16 code-unit offsets into that
   string** — a straight port of the byte-slice idiom over a `Buffer`
   corrupts every symbol name that follows non-ASCII text, silently (the
   spike's own repro: `"my_func"` via correct UTF-16 slice vs.
   `"ne\"\nmy_"` via a byte-offset slice on the same source). **72 of this
   repo's 76 indexed files contain non-ASCII** (Spike C §3), so this is not
   a corner case for this repo's own dogfooding. Mitigation already
   specified by the spike: slice the same JS string the parser indexed, and
   add a parity fixture with a non-BMP character positioned above a
   definition (item 3 of the golden-fixture list above).

6. **TS-port hazard — `.tsx` shares a language name with `.ts` but needs a
   separate grammar.** `EXTENSION_LANGUAGE` maps both `.ts` and `.tsx` to
   the single language name `"typescript"` (`code_graph.py:92`), and
   `GRAMMAR_MODULES` gives `"typescript"` one grammar module (`:76`). Spike
   C §6 measured that the typescript grammar parses `.tsx` source with
   `hasError = true` — a distinct `tsx` grammar exists and is required.
   Latent today (no `.ts`/`.tsx` file in this repo, no typescript grammar
   declared in `pyproject.toml`), but live the first time a repo containing
   React TSX is indexed post-port, and the failure mode reads as "this file
   is full of parse errors," not "wrong grammar chosen." The registry needs
   a dialect field or a separate `tsx` language row before that happens;
   not resolved here per the spike's own open-question framing.

7. **TS-port hazard — grammar bytes must load in-memory, never from a
   path.** The plan and Spike C are unambiguous that grammars load as
   `Uint8Array` bytes (`Language.load(bytes)`, `Parser.init({wasmBinary})`)
   with no `.wasm` file required on disk — this is the fact that makes a
   single-binary Windows build possible. `_load_grammars()`
   (`code_graph.py:144-178`) is the direct analogue on the Python side and
   should map cleanly, but the port must not regress to `locateFile`/
   filesystem-relative loading for convenience during development, since
   that quietly reintroduces the packaging dependency the whole spike
   exists to eliminate.

8. **TS-port hazard — `parse()` can return `null`.** Python's tree-sitter
   binding has no such case; `web-tree-sitter`'s type is `Tree | null`
   (Spike C §9 item 4). Never observed across this repo's 76 files, but
   must be handled explicitly (a parse error/skip, matching the existing
   `coverage.skipped` shape) rather than left to surface as a
   null-dereference deep in `_walk_tree`'s equivalent.

9. **TS-port hazard — `_ID`'s lookaround assertions are vestigial under
   every actual use, and a porter could reasonably "fix" that.**
   `governance_graph.py:41`: `re.compile(r"(?<![A-Za-z0-9-])(SP|[EFSTRDIL])-
   (\d{4})(?!\d)")`. Every call site uses `.fullmatch()`
   (`:93`, `:195`, `:233`) — never `.search()`/`.finditer()`. Under
   `fullmatch`, the string's start and end are already the match's start
   and end, so the negative lookbehind (nothing immediately before the
   match) and lookahead (no trailing digit) are **always trivially
   satisfied** and contribute nothing to any of the three live call sites.
   A JS port that (a) keeps the regex as an anchored full-string test
   (`^...$` plus the same lookaround, or equally, the lookaround dropped
   entirely) is behaviourally identical for every current use. The hazard
   is the *other* direction: if a future caller reuses `_ID` for substring
   extraction from a longer string (matching a bare id embedded in prose,
   say), the lookaround suddenly matters and must be preserved rather than
   silently dropped as "dead code" during the port. Also note the ASCII
   detail: JS `\d` is always `[0-9]`, while Python's `\d` on a `str`
   pattern matches any Unicode decimal digit by default — immaterial today
   because every id is minted by `next_id` as ASCII digits, but worth
   recording as a translation-fidelity note rather than assuming the two
   engines agree in general.

10. **TS-port hazard — alternation order in `_ID` is load-bearing and easy
    to lose in a rewrite.** `(SP|[EFSTRDIL])` must try `SP` before the
    single-character class, or `SP-0017` reads its first two characters as
    `S` followed by a literal `P` that fails to match `-`, and — depending
    on how a porter restructures the pattern — could silently misparse a
    sprint id as a story id. Asserted directly by
    `governance-graph-tests.sh:84-86` ("SP-9001 must be a sprint, not a
    story — prefix order matters") and `governance-graph-tests.sh:150-154`
    (`journal_of('SP-0017')` must resolve to `sprints.json`, not
    `design.json`). JS regex alternation is left-to-right first-match,
    identical to Python's, so a *literal* translation is safe — the hazard
    is specifically a "cleaner" rewrite (e.g. a lookup table keyed by
    single-character prefix with SP special-cased separately) reordering
    the check without preserving precedence.
