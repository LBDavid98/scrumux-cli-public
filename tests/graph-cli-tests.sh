#!/bin/sh
# graph-cli-tests.sh — T-0141: the one graph command that replaced
# code-graph and governance-graph.
#
# Three things, and only these three — the query LOGIC of both libraries is
# covered by code-graph-tests.sh, governance-graph-tests.sh and
# governance-graph-query-tests.sh, which were repointed rather than merged:
#
#   dispatch    — `graph code <cmd>` and `graph gov <cmd>` reach the right
#                 library, an unknown domain and an unknown subcommand are
#                 both refused naming the real ones, and `fresh` survives
#                 as an alias of `index` (D-0044).
#   staleness   — the D-0043 self-heal contract, for BOTH graphs, asserted
#                 through the CLI rather than the library: exit 0 when
#                 current, rebuild and exit 0 when stale. Plus T-0152's
#                 read side for `graph code`: a QUERY self-heals too, and
#                 its rebuild notice goes to stderr, never stdout.
#   hints       — the user-facing rebuild instructions emitted from inside
#                 the two libraries, and quoted by the two agent graphs and
#                 the blast-radius gold samples, name the command that now
#                 exists. A hint naming a deleted script is worse than no
#                 hint: it sends the agent to a file that is not there.
#
# The collapse is only real if the two old scripts are GONE. A wrapper that
# forwards to `graph` would keep every caller working and keep the script
# count exactly where it was, which is the opposite of the point.
#
# Run: sh tests/graph-cli-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GRAPH="$ROOT/.deploy-claude/scripts/scrumux"
GRAPH_CMD="graph"
PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY=python3

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

SCRATCH=$(mktemp -d) || { echo "graph-cli-tests: error: cannot create scratch dir" >&2; exit 1; }

# The code-graph half needs the grammars; the rest does not. Skipping is
# the true state, not a pass (D-0019), so the skip is announced and the
# code cases are the only ones dropped.
CODE_OK=0
"$PY" -c 'import tree_sitter, tree_sitter_bash, tree_sitter_python' 2>/dev/null && CODE_OK=1
[ "$CODE_OK" -eq 1 ] || printf 'graph-cli-tests: note: tree-sitter grammars absent — the `graph code` staleness cases are SKIPPED, not passed (D-0019)\n' >&2

CG_INDEX="$ROOT/governance/code-graph.json"
GG_INDEX="$ROOT/governance/governance-graph.json"

# Both index files are DERIVED, and every case below rebuilds what it
# removes — but a suite interrupted mid-run must not leave the repo
# without an index it had on entry.
[ -f "$CG_INDEX" ] && cp "$CG_INDEX" "$SCRATCH/code-graph.json.bak"
[ -f "$GG_INDEX" ] && cp "$GG_INDEX" "$SCRATCH/governance-graph.json.bak"
cleanup() {
  [ -f "$SCRATCH/code-graph.json.bak" ] && [ ! -s "$CG_INDEX" ] \
    && cp "$SCRATCH/code-graph.json.bak" "$CG_INDEX"
  [ -f "$SCRATCH/governance-graph.json.bak" ] && [ ! -s "$GG_INDEX" ] \
    && cp "$SCRATCH/governance-graph.json.bak" "$GG_INDEX"
  rm -rf "$SCRATCH"
}
# The rm -rf is on the trap line itself as well as inside cleanup():
# check-standards greps for `trap ... rm -rf ... EXIT` literally and does
# not resolve a named function (I filed that false positive under
# D-0062). ORDER MATTERS: cleanup() restores the index backups FROM
# $SCRATCH, so it must run BEFORE the removal, not after.
trap 'cleanup; rm -rf "$SCRATCH"' EXIT

# --- the collapse is real --------------------------------------------
[ -f "$GRAPH" ] && ok || bad "no .claude/scripts/scrumux graph — the collapse produced nothing"
[ -x "$GRAPH" ] && ok || bad ".claude/scripts/scrumux graph is not executable — every caller invokes it as a command"
MODE=$(ls -l "$GRAPH" | cut -c2-10)
[ "$MODE" = "rwxr-xr-x" ] && ok || bad "graph must be mode 755 like every other script in .claude/scripts — got '$MODE'"

for old in code-graph governance-graph; do
  if [ -e "$ROOT/.deploy-claude/scripts/$old" ]; then
    bad ".claude/scripts/$old still exists — T-0141 collapses the two into one; a forwarding wrapper leaves the script count where it was and is not a collapse"
  else
    ok
  fi
done

# --- dispatch ---------------------------------------------------------
# No domain at all, an invented domain, and a domain with no subcommand
# must each refuse and SAY what is real — an error that does not name the
# alternatives costs the agent another turn.
ERR=$("$GRAPH" $GRAPH_CMD 2>&1 >/dev/null); RC=$?
{ [ $RC -ne 0 ] && printf '%s' "$ERR" | grep -q 'graph code' && printf '%s' "$ERR" | grep -q 'graph gov'; } \
  && ok || bad "bare 'graph' must refuse and name the two domains — rc=$RC: $ERR"

ERR=$("$GRAPH" $GRAPH_CMD sideways 2>&1 >/dev/null); RC=$?
{ [ $RC -ne 0 ] && printf '%s' "$ERR" | grep -q "code" && printf '%s' "$ERR" | grep -q "gov"; } \
  && ok || bad "an unknown domain must be refused naming 'code' and 'gov' — rc=$RC: $ERR"

ERR=$("$GRAPH" $GRAPH_CMD code 2>&1 >/dev/null); RC=$?
{ [ $RC -ne 0 ] && printf '%s' "$ERR" | grep -q 'callers'; } \
  && ok || bad "'graph code' with no subcommand must list the code subcommands — rc=$RC: $ERR"

ERR=$("$GRAPH" $GRAPH_CMD gov 2>&1 >/dev/null); RC=$?
{ [ $RC -ne 0 ] && printf '%s' "$ERR" | grep -q 'provenance'; } \
  && ok || bad "'graph gov' with no subcommand must list the gov subcommands — rc=$RC: $ERR"

# Mutation probe: an oracle nobody has tried to break is a guess
# (T-0086/I-0021). An invented subcommand must be refused by each domain
# separately, and must NOT leak across — 'provenance' is a graph-gov command.
ERR=$("$GRAPH" $GRAPH_CMD code blastradius 2>&1 >/dev/null); RC=$?
{ [ $RC -ne 0 ] && printf '%s' "$ERR" | grep -q 'callers'; } \
  && ok || bad "'graph code blastradius' must be refused naming the real code subcommands — rc=$RC: $ERR"

ERR=$("$GRAPH" $GRAPH_CMD gov blastradius 2>&1 >/dev/null); RC=$?
{ [ $RC -ne 0 ] && printf '%s' "$ERR" | grep -q 'provenance'; } \
  && ok || bad "'graph gov blastradius' must be refused naming the real gov subcommands — rc=$RC: $ERR"

ERR=$("$GRAPH" $GRAPH_CMD code provenance T-0141 2>&1 >/dev/null); RC=$?
[ $RC -ne 0 ] \
  && ok || bad "'graph code provenance' must be refused — provenance is a graph-gov query, and one dispatch accepting the other's commands is how the two collapse into mush"

ERR=$("$GRAPH" $GRAPH_CMD gov callers lib.sh 2>&1 >/dev/null); RC=$?
[ $RC -ne 0 ] \
  && ok || bad "'graph gov callers' must be refused — callers is a code query"

# I-0118: an unknown FLAG is the same family as an unknown subcommand,
# and bearing used to swallow one as a path — `bearing --nonsense X`
# answered "path absent --nonsense" and still exited 0. Refusing costs
# one turn; answering a question nobody asked costs trust in every
# "path absent" line the command ever prints.
ERR=$("$GRAPH" $GRAPH_CMD gov bearing --nonsense .claude/scripts/scrumux 2>&1 >/dev/null); RC=$?
{ [ $RC -ne 0 ] && printf '%s' "$ERR" | grep -q -- '--nonsense'; } \
  && ok || bad "'graph gov bearing' must refuse an unknown flag naming it, not treat it as a path (I-0118) — rc=$RC: $ERR"

# --- dispatch reaches the right library -------------------------------
# stats is the cheapest proof that the domain landed where it was aimed:
# the two libraries report structurally different things.
OUT=$("$GRAPH" $GRAPH_CMD gov stats 2>/dev/null); RC=$?
{ [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q '^nodes ' && printf '%s' "$OUT" | grep -q '^dangling '; } \
  && ok || bad "'graph gov stats' must reach the governance library (nodes/edges/dangling) — rc=$RC: $OUT"

OUT=$("$GRAPH" $GRAPH_CMD gov provenance T-0141 2>/dev/null); RC=$?
[ $RC -eq 0 ] && ok || bad "'graph gov provenance T-0141' must answer — rc=$RC: $OUT"

if [ "$CODE_OK" -eq 1 ]; then
  OUT=$("$GRAPH" $GRAPH_CMD code stats 2>/dev/null); RC=$?
  { [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q '^files ' && printf '%s' "$OUT" | grep -q '^symbols '; } \
    && ok || bad "'graph code stats' must reach the code library (files/symbols/edges) — rc=$RC: $OUT"
fi

# --- from here on, the suite owns its own GOV_ROOT (I-0107) -----------
# The staleness cases below DELETE an index and assert the next command
# rebuilds it. Run against the live governance/ that is exactly what they
# did — while graph-gov-index and graph-code-index, two other registered
# checks, were reading those same files in the same fleet run. A suite
# that mutates shared live state is a flake generator, and it is the same
# mistake I-0090 recorded in another suite.
#
# GOV_ROOT moves the DATA only: code location still comes from $0
# (lib.sh:5-11), so `graph code` indexes this real working tree and
# writes its index into the sandbox. That is the whole point of the
# separation.
SBROOT=$(mktemp -d) || { echo "graph-cli-tests: error: cannot create sandbox root" >&2; exit 1; }
mkdir -p "$SBROOT/governance"
cp "$ROOT"/governance/*.json "$SBROOT/governance/" 2>/dev/null || :
export GOV_ROOT="$SBROOT"
GG_INDEX="$SBROOT/governance/governance-graph.json"
CG_INDEX="$SBROOT/governance/code-graph.json"

# --- D-0043 staleness contract: graph gov -----------------------------
# A missing index is the strongest form of stale, and unlike touching a
# journal it leaves the journals themselves alone. Self-heal means the
# command REBUILDS and exits 0; failing here is what trained people to
# ignore the check (I-0063).
rm -f "$GG_INDEX"
OUT=$("$GRAPH" $GRAPH_CMD gov index 2>&1); RC=$?
{ [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q 'rebuilt'; } \
  && ok || bad "'graph gov index' must rebuild a missing index and exit 0 (D-0043) — rc=$RC: $OUT"
[ -s "$GG_INDEX" ] && ok || bad "'graph gov index' reported success but wrote no index"

OUT=$("$GRAPH" $GRAPH_CMD gov index 2>&1); RC=$?
{ [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q 'index current'; } \
  && ok || bad "a second 'graph gov index' must report current, not rebuild again — rc=$RC: $OUT"

"$GRAPH" $GRAPH_CMD gov fresh >/dev/null 2>&1 \
  && bad "'graph gov fresh' still runs — the alias was dropped with the consolidation; D-0044 named 'index'" || ok

# --- D-0043 + T-0152 staleness contract: graph code -------------------
if [ "$CODE_OK" -eq 1 ]; then
  rm -f "$CG_INDEX"
  OUT=$("$GRAPH" $GRAPH_CMD code index 2>&1); RC=$?
  { [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -qE 'built|rebuilt'; } \
    && ok || bad "'graph code index' must build a missing index and exit 0 (D-0043) — rc=$RC: $OUT"
  [ -s "$CG_INDEX" ] && ok || bad "'graph code index' reported success but wrote no index"

  OUT=$("$GRAPH" $GRAPH_CMD code index 2>&1); RC=$?
  { [ $RC -eq 0 ] && printf '%s' "$OUT" | grep -q 'current'; } \
    && ok || bad "a second 'graph code index' must report current, not rebuild again — rc=$RC: $OUT"

  "$GRAPH" $GRAPH_CMD code fresh >/dev/null 2>&1 \
    && bad "'graph code fresh' still runs — the alias was dropped with the consolidation; D-0044 named 'index'" || ok

  # --- THE READER CONTRACT (replaces the T-0152 self-heal) ------------
  # A reader NEVER rebuilds. T-0152 made every query run a full parse so
  # a query could never answer from a stale index — which is precisely
  # what made a reader need a toolchain, and what made `graph code`
  # refuse in every deployed repo that has no grammars.
  #
  # The useful half of D-0043/D-0044 is kept a different way: the query
  # answers, and says on stderr how old its answer is. Nothing goes red
  # after a legitimate edit; nothing needs a parser to ask a question.
  "$GRAPH" $GRAPH_CMD code build >/dev/null 2>&1
  OUT=$("$GRAPH" $GRAPH_CMD code find harnessVerify 2>"$SCRATCH/query.err"); RC=$?
  [ $RC -eq 0 ] && ok || bad "a query against a present index must answer — rc=$RC: $(cat "$SCRATCH/query.err")"
  printf '%s\n' "$OUT" | grep -q '::harnessVerify$' \
    && ok || bad "the query must answer with real symbol ids — got '$OUT'"
  grep -q 'index built from' "$SCRATCH/query.err" \
    && ok || bad "every query must stamp its answer with the index's provenance, on stderr: $(cat "$SCRATCH/query.err")"
  printf '%s\n' "$OUT" | grep -qi 'index built from' \
    && bad "the provenance line reached stdout: '$OUT' — stdout is ids only" || ok

  # A STALE index still answers. It does not rebuild, and it does not refuse.
  # Touch a file that EXISTS. `touch` creates what it cannot find, and this
  # line named lib.sh — so when the bash CLI was retired it stopped bumping an
  # mtime and started planting a 0-byte lib.sh in the payload SOURCE, which
  # `harness verify` then reported as a shipped command nobody probed. A test
  # that writes into the working tree is I-0021; one that writes a file the
  # roster then picks up is that with a blast radius.
  touch "$ROOT/.deploy-claude/scripts/scrumux" 2>/dev/null || :
  BEFORE=$(shasum -a 256 "$CG_INDEX" | awk '{print $1}')
  OUT=$("$GRAPH" $GRAPH_CMD code find harnessVerify 2>"$SCRATCH/stale.err"); RC=$?
  [ $RC -eq 0 ] && ok || bad "a stale index must still answer — rc=$RC: $(cat "$SCRATCH/stale.err")"
  [ "$(shasum -a 256 "$CG_INDEX" | awk '{print $1}')" = "$BEFORE" ] \
    && ok || bad "a reader rebuilt the index — readers never rebuild"
  grep -q 'STALE' "$SCRATCH/stale.err" \
    && ok || bad "a stale answer must SAY it is stale: $(cat "$SCRATCH/stale.err")"

  # No index at all is the one reader state that fails — and the refusal
  # must name who can build one, never stop at "not here".
  rm -f "$CG_INDEX"
  OUT=$("$GRAPH" $GRAPH_CMD code find harnessVerify 2>"$SCRATCH/noidx.err"); RC=$?
  [ $RC -ne 0 ] && ok || bad "a query with no index at all must fail — rc=$RC"
  grep -q 'graph code build --repo' "$SCRATCH/noidx.err" \
    && ok || bad "the no-index refusal must name a builder that can fix it from elsewhere: $(cat "$SCRATCH/noidx.err")"
  "$GRAPH" $GRAPH_CMD code build >/dev/null 2>&1
fi

# --- the rebuild hints name a command that exists ---------------------
# These strings are instructions to a human or an agent, so they are checked
# at BOTH ends: emitted by the library, and quoted by whatever tells an agent
# what to run. The emitting end used to be driven by importing the python
# `is_stale`/`load_index` directly; the libraries are TypeScript, so it is
# driven the way an operator meets it — through the CLI, over a missing index
# and over a corrupt one.
CGSC=$(mktemp -d) || bad "could not mktemp for the hint cases"
mkdir -p "$CGSC/governance"
CGH=$( (cd "$CGSC" && GOV_ROOT="$CGSC" "$GRAPH" $GRAPH_CMD code find anything) 2>&1 )
printf '%s' "$CGH" | grep -q 'scrumux graph code build' \
  && ok || bad "the code graph's missing-index hint must name 'graph code build' — got '$CGH'"

# The GOV graph has no missing-index hint to give, and that is the D-0043
# self-heal rather than a gap: it needs no grammars and no interpreter, so it
# builds the index it was missing and answers, saying so. A hint telling an
# operator to run a command the CLI could have run itself is the thing D-0043
# removed; what has to hold is that it never leaves them with no answer.
GGH=$( (cd "$CGSC" && GOV_ROOT="$CGSC" "$GRAPH" $GRAPH_CMD gov stats) 2>&1 ); GGRC=$?
[ $GGRC -eq 0 ] && ok || bad "graph gov must self-heal a missing index rather than refuse — rc=$GGRC: $GGH"
printf '%s' "$GGH" | grep -q 'no index — built one' \
  && ok || bad "the self-heal must SAY it rebuilt, or an operator cannot tell a fresh answer from a stale one; got '$GGH'"

# a corrupt index must also point at the command that repairs it
printf 'not json' > "$CGSC/governance/code-graph.json"
CORR=$( (cd "$CGSC" && GOV_ROOT="$CGSC" "$GRAPH" $GRAPH_CMD code find anything) 2>&1 )
printf '%s' "$CORR" | grep -q 'scrumux graph code build' \
  && ok || bad "the corrupt-index error must name 'graph code build' — got '$CORR'"
rm -rf "$CGSC"

# the quoting end: the code that emits the hint. It was the python indexer
# (`agents/lib/code_graph.py`); the builder is TypeScript and the hint is
# written where the refusal is.
grep -qE 'scrumux graph code build' "$ROOT/src/nouns/graph.ts" \
  && ok || bad "src/nouns/graph.ts quotes the no-index hint but not the current command — the agent is told to run a script that does not exist"

# --- nothing this task owns still points at a deleted script ----------
# Scoped to T-0141's file set on purpose. `.claude/scripts/scrumux` also calls
# the old governance-graph (scrumux:96-103 and the `views` guard) and is OUT of
# this task's scope — it is handed to the orchestrator, not silently
# rewritten here, and not silently accepted by a repo-wide grep either.
DEAD_A="code-""graph"
DEAD_B="governance-""graph"
OWNED="agents/lib/code_graph.py
agents/lib/governance_graph.py
agents/lib/governance_graph.py
tests/code-graph-tests.sh
tests/governance-graph-tests.sh
tests/governance-graph-query-tests.sh
tests/context-builder-tests.sh
tests/graph-cli-tests.sh
SKILLS_INDEX.MD
.deploy-claude/scripts/lib/cmd-graph.sh"
OLDIFS=$IFS
IFS='
'
for f in $OWNED; do
  IFS=$OLDIFS
  # the pattern is assembled rather than written out, so this suite does
  # not match itself the way a literal grep for the dead path would
  if grep -q "scripts/${DEAD_A}\|scripts/${DEAD_B}" "$ROOT/$f" 2>/dev/null; then
    bad "$f still names the deleted script .claude/scripts/${DEAD_A} or .claude/scripts/${DEAD_B}"
  else
    ok
  fi
  IFS='
'
done
IFS=$OLDIFS

# --- a repo the harness has never seen (T-0213 / I-0111) --------------
# The FIRST thing a freshly deployed repo does is build its own
# governance graph, and `graph gov build` used to die there with a Python
# FileNotFoundError traceback because governance/ did not exist yet. A
# traceback is not an error message, and this is the one graph failure an
# app build actually hits.
FRESH=$(mktemp -d) || { echo "graph-cli-tests: cannot mktemp" >&2; exit 1; }
FOUT=$(GOV_ROOT="$FRESH" "$GRAPH" $GRAPH_CMD gov build 2>&1); FRC=$?
[ "$FRC" -eq 0 ] \
  && ok || bad "'graph gov build' must succeed on a root whose governance/ does not exist — a deployed repo starts there. rc=$FRC: $FOUT"
[ -f "$FRESH/governance/governance-graph.json" ] \
  && ok || bad "'graph gov build' reported success on a fresh root but wrote no index"
printf '%s' "$FOUT" | grep -qi 'traceback\|FileNotFoundError' \
  && bad "'graph gov build' leaked a Python traceback instead of an error message: $FOUT" || ok
rm -rf "$FRESH"

# --- code location and data location are different (T-0213 / I-0107) --
# `graph code` used to write its index to the harness checkout whatever
# GOV_ROOT said, because one variable answered both "where is the source"
# and "where does the index live". Any suite that rebuilt the index then
# raced every other reader of the live file.
CGSB=$(mktemp -d) || { echo "graph-cli-tests: cannot mktemp" >&2; exit 1; }
mkdir -p "$CGSB/governance"
CGOUT=$(GOV_ROOT="$CGSB" "$GRAPH" $GRAPH_CMD code build 2>&1); CGRC=$?
[ "$CGRC" -eq 0 ] \
  && ok || bad "'graph code build' must succeed under a sandbox GOV_ROOT — rc=$CGRC: $CGOUT"
[ -s "$CGSB/governance/code-graph.json" ] \
  && ok || bad "'graph code build' must write its index under GOV_ROOT, not into the harness checkout (I-0107)"
printf '%s' "$CGOUT" | grep -q 'governance/code-graph.json' \
  && ok || bad "the build must report its index path relative to the DATA root — a path relative to the code root raises ValueError when they differ: $CGOUT"
# and the source tree it indexed is still the real one, or the separation
# has gone the wrong way
printf '%s' "$CGOUT" | grep -qE '[1-9][0-9]* files' \
  && ok || bad "'graph code build' under a sandbox must still index the REAL working tree — code location comes from \$0, only the data moves: $CGOUT"
rm -rf "$CGSB"

printf 'graph-cli-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "graph-cli-tests: error: $FAIL assertion(s) failed — fix .claude/scripts/scrumux graph (dispatch and the D-0043 self-heal) or the rebuild hints in agents/lib/*_graph.py before trusting either graph" >&2
  exit 1
fi
exit 0
