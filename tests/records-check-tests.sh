#!/bin/sh
# records-check-tests.sh — proves .claude/scripts/scrumux records check catches corruption
# (T-0011 acceptance) and enforces the mechanical code standards
# (T-0019/D-0012 acceptance, folded in from the retired standards-tests.sh
# by T-0140 when the three checkers became one script).
#
# Three parts:
#   1. structure  — a valid fixture built via scrumux in a sandbox validates
#                   clean, then one corruption class at a time is injected
#                   and each is asserted caught by name.
#   2. modes      — the mode matrix and the output contracts every caller
#                   depends on: no flag means --structure, --porcelain is
#                   problem<TAB>fix, w() never changes the exit code, and
#                   a schema sweep that cannot run is a finding.
#   3. standards  — each mechanical standard catches a seeded violation by
#                   name, and a clean or non-code tree produces zero
#                   findings.
# Run from repo root.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
VAL="$ROOT/.deploy-claude/scripts/scrumux"
VAL_CMD="records check"
SANDBOX=$(mktemp -d) || { echo "records-check-tests: error: cannot create sandbox — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# a hand edit breaks the content seal (T-0100), which is a SECOND finding
# unrelated to what a case is testing. Resealing makes a fixture mean
# "scrumux wrote this state", which is what these cases probe.
# RESEAL AFTER A HAND EDIT, so the edit does not read as tampering. It used
# to source lib.sh and call `seal_journals`; the seal map is rewritten by any
# governance WRITE, so the cheapest surface that reseals every journal is a
# `repair journal` that applies the identity filter.
reseal() {
  # bash's `seal_journals` rebuilt the WHOLE map from whatever the journals
  # held; a normal write updates only the one key it touched, so the map is
  # DROPPED and rebuilt by the bootstrap on the next write. That is the same
  # laundering the old helper did, and it is what a fixture that hand-edits a
  # journal needs — outside a fixture it is exactly what seals.json exists to
  # catch, which is why no product path does it.
  rm -f "$GOV_ROOT/governance/seals.json"
  "$ROOT/.deploy-claude/scripts/scrumux" repair journal log.json \
    --apply '.' --why 'reseal after a fixture edit' --by tests >/dev/null 2>&1 || true
}

# ======================================================================
# 1. structure
# ======================================================================

# --- valid fixture via scrumux (write-time-legal state) -------------------
"$GOVCMD" feature new --name F --desc D >/dev/null
"$GOVCMD" story new --feature F-0001 --narrative N --criterion C >/dev/null
"$GOVCMD" epic new --name E --desc D --feature F-0001 >/dev/null
"$GOVCMD" task new --title T --check AC --feature F-0001 --story S-0001 >/dev/null
"$GOVCMD" task order T-0001 --scope S --verify true --out O --file "a | b" >/dev/null
"$GOVCMD" sprint new --epic E-0001 >/dev/null
"$GOVCMD" sprint add SP-0001 T-0001 >/dev/null
"$GOVCMD" sprint ratify SP-0001 --by tester --authority direct >/dev/null
"$GOVCMD" log new --task T-0001 --title L --did D >/dev/null
"$GOVCMD" issue new --type defect --source claude --summary Sum --fix Fix >/dev/null
"$GOVCMD" decide new --title T --decision D --rationale R --by W >/dev/null
"$GOVCMD" review --task T-0001 --scope pass --governance pass --code-diff pass --blast-radius pass >/dev/null

if "$VAL" $VAL_CMD >/dev/null 2>&1; then ok; else bad "valid fixture should records-check clean"; "$VAL" $VAL_CMD >&2; fi

corrupt() { # corrupt <file> <jq-program> <expected-substring> <desc>
  file="$SANDBOX/governance/$1"; prog=$2; expect=$3; desc=$4
  cp "$file" "$file.orig"
  jq "$prog" "$file" > "$file.tmp" && mv "$file.tmp" "$file"
  OUT=$("$VAL" $VAL_CMD 2>&1); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$OUT" | grep -qF -- "$expect"; then ok; else bad "$desc — want exit!=0 mentioning '$expect', got rc=$rc"; fi
  mv "$file.orig" "$file"
}

# 1. invalid enum
# T-0113 moved the status enum out of hardcoded jq and into the schema
# sweep, which reads task.schema.json. The gap must still be caught; the
# message is the schema reader's and names the valid values.
corrupt tasks.json '.entries[0].status = "bogus"' "'bogus' not one of" "bad status enum caught"
# 2. dangling ref
corrupt tasks.json '.entries[0].story = "S-9999"' 'story S-9999 unresolved' "dangling story ref caught"
# 3. duplicate id
corrupt log.json '.entries += [.entries[0]]' 'duplicate ids' "duplicate id caught"
# 4. missing required field
corrupt issues.json '.entries[0].resolution_pointer = ""' 'missing resolution_pointer' "missing resolution_pointer caught"
# 5. gate bypass: accepted with no ruling on record. D-0076/T-0187 moved
#    the ruling from the review to the task; either form counts as
#    evidence, and a status flipped by hand has neither.
corrupt tasks.json '.entries[0].status = "accepted"' 'accepted with no recorded acceptance' "hand-edited acceptance caught"
# 6. sprint integrity: ratified without record
corrupt sprints.json '.entries[0].ratified = null' 'ratified without ratification record' "missing ratification record caught"
# 7. broken JSON
cp "$SANDBOX/governance/tasks.json" "$SANDBOX/governance/tasks.json.orig"
printf '{broken' > "$SANDBOX/governance/tasks.json"
OUT=$("$VAL" $VAL_CMD 2>&1); rc=$?
if [ $rc -ne 0 ] && printf '%s' "$OUT" | grep -q 'not valid JSON'; then ok; else bad "broken JSON caught — got rc=$rc"; fi
mv "$SANDBOX/governance/tasks.json.orig" "$SANDBOX/governance/tasks.json"

# 8. rules chain: rule pointing at a missing script
mkdir -p "$SANDBOX/.claude/rules"
printf -- '---\nname: test-rule\npaths: ["**"]\nscripts: [".claude/scripts/does-not-exist"]\n---\n# Rule: test\n' > "$SANDBOX/.claude/rules/test-rule.md"
OUT=$("$VAL" $VAL_CMD 2>&1); rc=$?
if [ $rc -ne 0 ] && printf '%s' "$OUT" | grep -qF 'does-not-exist which does not exist'; then ok; else bad "dangling script pointer caught — got rc=$rc: $OUT"; fi
rm -f "$SANDBOX/.claude/rules/test-rule.md"

# 9. still clean after all restorations
if "$VAL" $VAL_CMD >/dev/null 2>&1; then ok; else bad "fixture should be clean again after restorations"; fi

# ======================================================================
# 2. modes and output contracts (T-0140)
# ======================================================================

# --- no mode flag means --structure ----------------------------------
# The repo-health entry and the compliance hook both call the validator
# with no mode, and both meant "the governance sweep" before the rename.
# If the default ever drifts, they silently start meaning something else.
NOFLAG=$("$VAL" $VAL_CMD 2>&1); nrc=$?
STRUCT=$("$VAL" $VAL_CMD --structure 2>&1); src=$?
[ "$NOFLAG" = "$STRUCT" ] && [ "$nrc" -eq "$src" ] \
  && ok || bad "no mode flag must mean --structure — outputs/rcs differ ($nrc vs $src)"

# --- an unknown flag fails with the '<problem> — <fix>' shape ---------
OUT=$("$VAL" $VAL_CMD --bogus-mode 2>&1); rc=$?
if [ $rc -ne 0 ] && printf '%s' "$OUT" | grep -q 'error:' && printf '%s' "$OUT" | grep -q 'usage:'; then ok
else bad "an unknown mode flag must fail naming the usage — got rc=$rc: $OUT"; fi

# --- --json is one object: problem, fix, tier, per finding ------------
# --porcelain is gone. It was a TSV encoding of THIS finding set,
# invented because --json existed on nothing but `harness`, and its only
# non-test consumer was the compliance monitor hook that T-0186 deleted.
# Two machine formats for one finding set is the D-0010 drift this
# validator exists to catch, so the format the validator emitted is the
# one it lost.
#
# The em-dash split it did is KEPT and is now done for every consumer:
# a row's NAME is the problem and its DETAIL is the fix, split once. A
# machine consumer dedups on the name (I-0032), so a second em-dash in
# the name would mint duplicate issues.
cp "$SANDBOX/governance/tasks.json" "$SANDBOX/governance/tasks.json.orig"
jq '.entries[0].status = "bogus"' "$SANDBOX/governance/tasks.json.orig" > "$SANDBOX/governance/tasks.json"
reseal
"$VAL" $VAL_CMD --json > "$SANDBOX/json.out" 2>/dev/null; prc=$?
"$VAL" $VAL_CMD > "$SANDBOX/human.out" 2>/dev/null
[ "$prc" -eq 1 ] && ok || bad "--json must exit 1 when there are findings, got $prc"
[ -s "$SANDBOX/json.out" ] && ok || bad "--json produced no output for a seeded finding"
[ "$(jq -s 'length' "$SANDBOX/json.out" 2>/dev/null)" = "1" ] \
  && ok || bad "--json must emit exactly ONE object — the app must never parse prose: $(cat "$SANDBOX/json.out")"
jq -e '.ok == false and .exit == 1' "$SANDBOX/json.out" >/dev/null 2>&1 \
  && ok || bad "--json must carry ok:false and exit:1 with a finding present"
jq -e '[.checks[] | select(.tier == "fail")] | length > 0' "$SANDBOX/json.out" >/dev/null 2>&1 \
  && ok || bad "the seeded finding must appear as a fail row"
jq -e '[.checks[] | select(.tier == "fail") | select(.name | contains(" — "))] | length == 0' "$SANDBOX/json.out" >/dev/null 2>&1 \
  && ok || bad "the em-dash split must happen exactly once — a name containing ' — ' means a consumer deduping on it will mint duplicates: $(jq -c '[.checks[]|select(.tier=="fail")|.name]' "$SANDBOX/json.out")"
jq -e '[.checks[] | select(.tier == "fail") | select(.detail == "")] | length == 0' "$SANDBOX/json.out" >/dev/null 2>&1 \
  && ok || bad "every finding must carry a fix in .detail, never just name the problem"
jq -e '[.checks[] | select(.name | test("^FAIL"))] | length == 0' "$SANDBOX/json.out" >/dev/null 2>&1 \
  && ok || bad "--json must carry no prose tier marker inside a name"
JLINES=$(jq '[.checks[] | select(.tier == "fail")] | length' "$SANDBOX/json.out")
HLINES=$(grep -cE '^  FAIL ' "$SANDBOX/human.out")
[ "$JLINES" = "$HLINES" ] && ok || bad "--json must carry one fail row per human FAIL line — $JLINES json vs $HLINES human"
mv "$SANDBOX/governance/tasks.json.orig" "$SANDBOX/governance/tasks.json"
reseal

# --- a broken schema file fails closed, never silently ------------------
# T-0129: a dependency that cannot run must fail closed. The sweep is
# native (src/schema/check.ts, R-004) and reads its schemas from the CODE
# root, not GOV_ROOT — so proving the fail-closed path means corrupting the
# real schema file the running binary reads, not one under the sandbox.
# Restored unconditionally on the way out so a failed run can't leave the
# repo's schema corrupted.
#
# Every journal must have ZERO entries: checkJournal only dereferences a
# journal's schema once it has an entry to check, so a non-empty tasks.json
# would catch the break at the per-journal level (a normal `schema:` FAIL)
# and never reach the coverage sweep's own read of the same file — which is
# the arm this case exists to prove.
FC="$SANDBOX/failclosed"
rm -rf "$FC"; mkdir -p "$FC/governance"
for _fj in tasks issues exceptions decisions log sprints repo-health; do
  printf '{"entries": []}\n' > "$FC/governance/$_fj.json"
done
REAL_SCHEMA="$ROOT/.deploy-claude/schemas/task.schema.json"
cp "$REAL_SCHEMA" "$SANDBOX/task.schema.orig"
restore_schema() { cp "$SANDBOX/task.schema.orig" "$REAL_SCHEMA"; }
trap 'restore_schema; rm -rf "$SANDBOX"' EXIT
printf '[]\n' > "$REAL_SCHEMA"
OUT=$(GOV_ROOT="$FC" "$VAL" $VAL_CMD 2>&1); rc=$?
restore_schema
trap 'rm -rf "$SANDBOX"' EXIT
printf '%s' "$OUT" | grep -q 'NOT checked' && ok \
  || bad "a schema sweep that cannot run must be a finding, not a silent skip: $OUT"
[ "$rc" -ne 0 ] && ok || bad "the validator exited 0 with its schema sweep unable to run"

# ...and with the module present it really does run: a schema-only
# violation must both print AND count (the T-0129 subshell defect printed
# FAIL and exited 0).
jq '.entries[0].status = "bogus_status_for_test"' "$SANDBOX/governance/tasks.json" > "$SANDBOX/t.j" \
  && mv "$SANDBOX/t.j" "$SANDBOX/governance/tasks.json"
reseal
OUT=$("$VAL" $VAL_CMD 2>&1); rc=$?
printf '%s' "$OUT" | grep -qE 'FAIL +schema:' && ok || bad "the schema violation was not reported at all"
[ "$rc" -ne 0 ] && ok || bad "a reported schema violation must COUNT — f() is running in a subshell again"
printf '%s' "$OUT" | grep -qi 'clean' && bad "it reported 'clean' while printing a FAIL line" || ok
jq '.entries[0].status = "proposed"' "$SANDBOX/governance/tasks.json" > "$SANDBOX/t.j" \
  && mv "$SANDBOX/t.j" "$SANDBOX/governance/tasks.json"
reseal

# --- w() warnings never affect the exit code -------------------------
# The self-validated-issue sweep is a retrospective observation over
# historical rows. As an f() it would turn the repo red AND mint one
# drift issue per row through the monitor's porcelain pipe (I-0054).
"$GOVCMD" issue validate I-0001 --verdict evidenced --evidence "seeded" --by issue-validator >/dev/null 2>&1
jq '.entries[0].validation.by = .entries[0].source' "$SANDBOX/governance/issues.json" > "$SANDBOX/i.j" \
  && mv "$SANDBOX/i.j" "$SANDBOX/governance/issues.json"
reseal
OUT=$("$VAL" $VAL_CMD 2>&1); rc=$?
printf '%s' "$OUT" | grep -qE 'WARN +self-validated issues' && ok \
  || bad "a self-validated issue must be surfaced as a WARN: $OUT"
[ "$rc" -eq 0 ] && ok || bad "a w() warning must not affect the exit code — got rc=$rc"
POUT=$("$VAL" $VAL_CMD --porcelain 2>&1)
printf '%s' "$POUT" | grep -q 'self-validated' \
  && bad "a warning must never reach porcelain — the monitor would mint a drift issue per historical row" || ok

# ======================================================================
# 3. standards (folded in from standards-tests.sh, T-0019/D-0012)
# ======================================================================

expect_clean() { # expect_clean <dir> <desc>
  out=$("$VAL" $VAL_CMD --standards "$1" 2>&1); rc=$?
  if [ $rc -eq 0 ] && ! printf '%s' "$out" | grep -q 'FAIL:'; then ok
  else bad "$2 — want clean exit 0, got rc=$rc: '$out'"; fi
}
expect_finding() { # expect_finding <dir> <substring> <desc>
  out=$("$VAL" $VAL_CMD --standards "$1" 2>&1); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qF -- "$2"; then ok
  else bad "$3 — want finding mentioning '$2', got rc=$rc: '$out'"; fi
}

# --- empty / non-code tree is clean ----------------------------------
mkdir -p "$SANDBOX/empty"
expect_clean "$SANDBOX/empty" "empty tree"
mkdir -p "$SANDBOX/docs"; printf '# notes\n' > "$SANDBOX/docs/README.md"
expect_clean "$SANDBOX/docs" "markdown-only tree"

# --- clean Python/TS tree is clean -----------------------------------
mkdir -p "$SANDBOX/clean/src"
cat > "$SANDBOX/clean/src/agent.py" <<'EOF'
"""A LangGraph agent calling the gateway for real."""
from langgraph.graph import StateGraph
import httpx
EOF
printf 'export const x: number = 1\n' > "$SANDBOX/clean/src/util.ts"
expect_clean "$SANDBOX/clean" "conforming python+ts tree"

# --- standard 1: foreign language ------------------------------------
mkdir -p "$SANDBOX/s1/src"

# --- standard 3: competing agent framework ---------------------------
mkdir -p "$SANDBOX/s3/src"
mkdir -p "$SANDBOX/s3b/src"
printf 'from langchain.agents import AgentExecutor\n' > "$SANDBOX/s3b/src/lc.py"

mkdir -p "$SANDBOX/s6/src"
mkdir -p "$SANDBOX/s6b/tests"
printf 'llm = FakeListLLM(responses=["hi"])\n' > "$SANDBOX/s6b/tests/test_agent.py"

# --- pruned dirs stay silent -----------------------------------------
mkdir -p "$SANDBOX/pruned/node_modules/dep"
expect_clean "$SANDBOX/pruned" "node_modules pruned"

# --- the standards mode carries no built-in stack rules ---------------
# Python/TypeScript-only, LangGraph-for-agents and no-mock-LLM were one
# person's stack hardcoded into a harness that claims to govern any repo
# in any language. A repo's standards live in its own
# .claude/rules/project-standards.md, and anything mechanical about them
# is registered with scrumux health.
out=$("$VAL" $VAL_CMD --standards "$SANDBOX/s6" 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok || bad "--standards must not fail a repo for its choice of language — rc=$rc"
printf '%s' "$out" | grep -q 'project-standards.md' \
  && ok || bad "--standards must point at where a repo's own standards go: $out"

# --- --all runs both sweeps in one pass -------------------------------
# The structure half reads GOV_ROOT; the standards half reads the given
# directory. A caller asking for both must get findings from both.
cp "$SANDBOX/governance/tasks.json" "$SANDBOX/governance/tasks.json.orig"
jq '.entries[0].story = "S-9999"' "$SANDBOX/governance/tasks.json.orig" > "$SANDBOX/governance/tasks.json"
reseal
OUT=$("$VAL" $VAL_CMD --all "$SANDBOX/s1" 2>&1); rc=$?
[ "$rc" -ne 0 ] && ok || bad "--all must exit 1 when the structure half finds something"
printf '%s' "$OUT" | grep -q 'story S-9999 unresolved' && ok || bad "--all must run the structure sweep: $OUT"
mv "$SANDBOX/governance/tasks.json.orig" "$SANDBOX/governance/tasks.json"
reseal
# and a mode runs ONLY its own sweep
OUT=$("$VAL" $VAL_CMD --standards "$SANDBOX/s1" 2>&1)
printf '%s' "$OUT" | grep -q 'governance/' \
  && bad "--standards must not run the structure sweep: $OUT" || ok


# --- OQ-2 (D-0085): unsupported schema keywords are REPORTED ------------
# schema_check.py carries unsupported_keywords() with a docstring saying a
# schema author "must not believe an unenforced keyword is enforced" -- and
# NOTHING ever called it (git log -S finds one commit: the one that added
# it). So an unsupported keyword was silently ignored, which is precisely
# the outcome the function exists to prevent. Measured at the time of
# wiring: 82 keywords across 7 shipped schemas -- every `pattern`,
# `minLength`, `format` and `minimum` is declared and not enforced.
#
# Reported as ONE aggregate row, not 82. A detector that fires 82 times on
# a clean repo teaches the operator to ignore it -- the same reasoning
# cmd-records.sh already applies to the 145 authority-less acceptances.
# Driven through the CLI. It was `python3 -m agents.lib.schema_check` until
# the sweep went native and the module was retired; the WARNING it produces
# is the operator-facing form of the same UNSUPPORTED line.
SCHEMA_SUMMARY=$(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$VAL" $VAL_CMD 2>&1 | grep 'schema coverage:')
[ -n "$SCHEMA_SUMMARY" ] \
  && ok || bad "OQ-2: the schema sweep must report unsupported keywords; got no UNSUPPORTED line"
printf '%s' "$SCHEMA_SUMMARY" | grep -qE 'pattern|minLength' \
  && ok || bad "OQ-2: the summary must name the unenforced keywords; got: $SCHEMA_SUMMARY"

# it must NOT move the exit code: an unenforced keyword is a fact about
# this reader's coverage, not a defect in any record.
(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$VAL" $VAL_CMD >/dev/null 2>&1)
[ $? -eq 0 ] \
  && ok || bad "OQ-2: reporting unsupported keywords must not fail the sweep over conforming records"

# the detail is reachable on demand rather than printed every run
DETAIL=$(cd "$ROOT" && GOV_ROOT="$SANDBOX" "$VAL" $VAL_CMD --unsupported 2>/dev/null | grep 'unsupported keyword' | wc -l | tr -d ' ')
[ "${DETAIL:-0}" -gt 10 ] \
  && ok || bad "OQ-2: --unsupported must list the individual keywords; got $DETAIL line(s)"

# --- OQ-19 (D-0085): a sealed-listed journal with NO seal entry ---------
# broken_seals drives off the seal MAP, so a journal in SEALED_JOURNALS and
# present on disk but absent from seals.json is never compared and never
# reported. seals_shape_problem catches an empty or malformed map, not an
# INCOMPLETE one -- and incomplete is the case that occurs naturally, since
# seal_journals skips a journal that did not exist at bootstrap.
SB_SEAL=$(mktemp -d) || exit 1
mkdir -p "$SB_SEAL/governance"
printf '{"entries":[]}\n' > "$SB_SEAL/governance/tasks.json"
printf '{"entries":[]}\n' > "$SB_SEAL/governance/decisions.json"
# a seal map that knows about tasks.json and not about decisions.json
printf '{"sealed_at":"2026-01-01","journals":{"tasks.json":"%s"}}\n' \
  "$(shasum -a 256 "$SB_SEAL/governance/tasks.json" | awk '{print $1}')" \
  > "$SB_SEAL/governance/seals.json"
SEALOUT=$(GOV_ROOT="$SB_SEAL" "$VAL" $VAL_CMD --structure 2>&1)
printf '%s' "$SEALOUT" | grep -q 'decisions.json' \
  && ok || bad "OQ-19: a sealed-listed journal absent from the seal map must be named — nothing is comparing it; got: $SEALOUT"
rm -rf "$SB_SEAL"

printf 'records-check-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "records-check-tests: error: $FAIL assertion(s) failed — .claude/scripts/scrumux records check has a gap; fix the validator before trusting the sweep" >&2
  exit 1
fi
exit 0
