#!/bin/sh
# issue-validate-tests.sh — T-0034: validate-before-fix gate.
# scrumux issue validate records a verdict with evidence; the hotfix lane
# refuses unvalidated or invalidated issues. GOV_ROOT sandbox; the real
# governance/ journals are never touched. Run: sh tests/issue-validate-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
SANDBOX=$(mktemp -d) || { echo "issue-validate-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }


expect_out() {
  exp=$1; desc=$2; shift 2
  out=$("$@" 2>&1); rc=$?
  if [ $rc -eq 0 ] && [ "$out" = "$exp" ]; then ok; else bad "$desc — want '$exp' rc=0, got '$out' rc=$rc"; fi
}
expect_fail() {
  sub=$1; desc=$2; shift 2
  out=$("$@" 2>&1); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qF -- "$sub"; then ok; else bad "$desc — want failure mentioning '$sub', got rc=$rc: '$out'"; fi
}

# fixtures: two issues
"$GOVCMD" issue new --type defect --source claude --summary S1 --fix F1 --severity low >/dev/null 2>&1
"$GOVCMD" issue new --type defect --source claude --summary S2 --fix F2 --severity low >/dev/null 2>&1

# --- guards -----------------------------------------------------------
expect_fail "not found" "records-check unknown issue guard" "$GOVCMD" issue validate I-9999 --verdict reproduced --evidence E
expect_fail "reproduced|evidenced|invalidated" "verdict enum guard" "$GOVCMD" issue validate I-0001 --verdict bogus --evidence E
expect_fail "--evidence is required" "evidence guard" "$GOVCMD" issue validate I-0001 --verdict reproduced
expect_fail "unknown flag" "unknown flag guard" "$GOVCMD" issue validate I-0001 --verdict reproduced --evidence E --status open

# --- hotfix gate: unvalidated refuses --------------------------------
expect_fail "neither validation nor authorization" "hotfix refuses ungated issue" "$GOVCMD" sprint new --hotfix --issue I-0001
expect_fail "scrumux issue validate I-0001" "refusal names the fix command" "$GOVCMD" sprint new --hotfix --issue I-0001

# --- happy path: reproduced with repro-cmd ---------------------------
expect_out "I-0001 validated: reproduced" "records-check reproduced" "$GOVCMD" issue validate I-0001 --verdict reproduced --evidence "exit 3 observed" --repro-cmd "sh run.sh" --by tester
V=$(jq -r '.entries[] | select(.id=="I-0001") | "\(.validation.verdict) \(.validation.evidence) \(.validation.repro_cmd) \(.validation.by)"' "$SANDBOX/governance/issues.json")
[ "$V" = "reproduced exit 3 observed sh run.sh tester" ] && ok || bad "validation persisted — got '$V'"
expect_out SP-0001 "hotfix allows validated issue" "$GOVCMD" sprint new --hotfix --issue I-0001

# --- Harden C: a verdict the gate cannot read does NOT promote -------
# The `case` in cmd-sprint.sh named four verdicts and had no `*)` arm, so
# anything outside that vocabulary fell straight through and OPENED the
# hotfix sprint. Both shapes are seeded by hand, because scrumux itself
# refuses to write either one — which is the point: they arrive from a
# hand-edited journal, an older tool, or a future vocabulary, and a gate
# defeated by a string nobody chose is not a gate.
#
# The refusal must name the vocabulary AND the command that records a
# verdict (Article 5), and it must write no sprint — a gate that refuses
# and allocates an SP id anyway has not refused.
"$GOVCMD" issue new --type defect --source claude --summary "unreadable verdict" --fix F >/dev/null 2>&1
ODD=$(jq -r '[.entries[] | select(.summary=="unreadable verdict")][0].id' "$SANDBOX/governance/issues.json")
"$GOVCMD" issue new --type defect --source claude --summary "verdict-less validation" --fix F >/dev/null 2>&1
BARE=$(jq -r '[.entries[] | select(.summary=="verdict-less validation")][0].id' "$SANDBOX/governance/issues.json")
jq --arg o "$ODD" --arg b "$BARE" '.entries |= map(
    if .id==$o then .validation = {verdict:"anything", evidence:"e", by:"debugger", date:"2026-08-01"}
    elif .id==$b then .validation = {evidence:"e", by:"debugger", date:"2026-08-01"}
    else . end)' \
  "$SANDBOX/governance/issues.json" > "$SANDBOX/i.tmp" && mv "$SANDBOX/i.tmp" "$SANDBOX/governance/issues.json"
SPRINTS_BEFORE=$(jq '.entries | length' "$SANDBOX/governance/sprints.json")

expect_fail "does not recognise (verdict: anything)" "an unrecognised verdict does not promote" \
  "$GOVCMD" sprint new --hotfix --issue "$ODD"
expect_fail "reproduced or evidenced" "the refusal names the verdicts that DO open the lane" \
  "$GOVCMD" sprint new --hotfix --issue "$ODD"
expect_fail "scrumux issue validate $ODD --verdict" "the refusal names the command that records one" \
  "$GOVCMD" sprint new --hotfix --issue "$ODD"
expect_fail "does not recognise (verdict: null)" "a validation with no verdict does not promote" \
  "$GOVCMD" sprint new --hotfix --issue "$BARE"

SPRINTS_AFTER=$(jq '.entries | length' "$SANDBOX/governance/sprints.json")
[ "$SPRINTS_BEFORE" = "$SPRINTS_AFTER" ] && ok \
  || bad "a refused promotion must write no sprint — sprints went from $SPRINTS_BEFORE to $SPRINTS_AFTER"

# The two rows are removed again, and that is not tidiness. They are
# journal-INVALID by construction — the schema pins the verdict enum, which
# is why `issue validate` cannot write either shape — so leaving them in
# would turn the retrospective `records check` at the bottom of this file
# red for the fixture rather than for the thing it asserts.
jq --arg o "$ODD" --arg b "$BARE" '.entries |= map(select(.id != $o and .id != $b))' \
  "$SANDBOX/governance/issues.json" > "$SANDBOX/i.tmp" && mv "$SANDBOX/i.tmp" "$SANDBOX/governance/issues.json"

# --- invalidated: gate instructs closing, not fixing -----------------
expect_out "I-0002 validated: invalidated" "records-check invalidated" "$GOVCMD" issue validate I-0002 --verdict invalidated --evidence "cannot reproduce; code path removed"
expect_fail "close it instead of fixing it" "hotfix refuses invalidated" "$GOVCMD" sprint new --hotfix --issue I-0002
expect_out "I-0002 updated" "invalidated closes as rejected" "$GOVCMD" issue update I-0002 --status rejected

# --- a verdict is WRITE-ONCE, and superseding one keeps it (F7) -------
# This block used to assert the opposite: that a second validate silently
# replaced the first. It does not, and the reason it does not is that the
# verdict is what BOTH promotion gates read, so a second run erased a
# disjoint validator's evidence with nothing to show it had. Found by
# probing the critical issue in the first end-to-end operator run, which
# destroyed a 3,886-character evidence block with one word.
expect_fail "already carries a validation" "second validate refuses" "$GOVCMD" issue validate I-0001 --verdict evidenced --evidence "narrowed: design gap, not runtime"
V2=$(jq -r '.entries[] | select(.id=="I-0001") | .validation.verdict' "$SANDBOX/governance/issues.json")
[ "$V2" = "reproduced" ] && ok || bad "the refused write must leave the first verdict standing — got '$V2'"

expect_out "I-0001 re-validated: evidenced — the prior verdict 'reproduced' by 'tester' is kept in .validation_history" "--revalidate supersedes deliberately" "$GOVCMD" issue validate I-0001 --verdict evidenced --evidence "narrowed: design gap, not runtime" --revalidate
V3=$(jq -r '.entries[] | select(.id=="I-0001") | .validation.verdict' "$SANDBOX/governance/issues.json")
[ "$V3" = "evidenced" ] && ok || bad "the superseding verdict must land — got '$V3'"
# The half that makes the guard honest: the prior verdict is KEPT.
VH=$(jq -r '.entries[] | select(.id=="I-0001") | .validation_history[0].verdict' "$SANDBOX/governance/issues.json")
[ "$VH" = "reproduced" ] && ok || bad "the prior verdict must survive in .validation_history — got '$VH'"

# --- journals stay valid ---------------------------------------------
jq -e . "$SANDBOX/governance/issues.json" >/dev/null 2>&1 && ok || bad "issues.json invalid JSON after validation writes"

# --- T-0111/I-0054: an agent may not certify its own report ----------
# The requirement lived only in sprint-plan Step 1b prose, and was
# breached fourteen times in one session. Refusal is DISJOINTNESS ONLY:
# T-0130: source is now an enum, so this fixture uses 'audit-agent' for BOTH
# --source and --by, and a value no other fixture in this file uses so
# the id lookup below cannot select someone else's issue. The equality
# is the whole point — scrumux refuses only
# when the validator IS the reporter — so if you change one, change both
# or this assertion silently stops testing anything.
# a roster allowlist was designed and rejected because it would reject
# User and every 'claude' validation while making the validator's own
# reports permanently unvalidatable.
"$GOVCMD" issue new --type defect --source audit-agent --summary "raised by audit-agent" --fix F >/dev/null 2>&1
SELF=$(jq -r '[.entries[] | select(.source=="audit-agent")][0].id' "$SANDBOX/governance/issues.json")

OUT=$("$GOVCMD" issue validate "$SELF" --verdict evidenced --evidence E --by audit-agent 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "an agent validating its own report must be refused — rc=$RC: $OUT"
# I-0099/T-0173: the refusal must name the SUPPORTED path, not the one it
# just refused. A message that says "record with --by <the source>"
# prescribes the exact command the gate rejected, which is why the
# validator's own reports were permanently unvalidatable. Two halves:
# it must NOT prescribe --by the source, and it must name a read-only
# identity other than the source to dispatch instead.
printf '%s' "$OUT" | grep -qF -- '--by audit-agent' \
  && bad "the refusal must not prescribe --by the source it just refused: $OUT" || ok
printf '%s' "$OUT" | grep -qE 'issue-validator|debugger|context-gatherer' \
  && ok || bad "the refusal must name a read-only identity to dispatch instead: $OUT"
jq -e --arg i "$SELF" '[.entries[] | select(.id==$i and .validation==null)] | length == 1' \
  "$SANDBOX/governance/issues.json" >/dev/null \
  && ok || bad "a refused validation must write nothing"

# a different agent may records-check it — issue-validator IS a valid
# substitute here, because the source is audit-agent. The rule is
# disjointness, never a roster that excludes one identity outright.
"$GOVCMD" issue validate "$SELF" --verdict evidenced --evidence E --by issue-validator >/dev/null 2>&1 \
  && ok || bad "an independent agent must be able to validate the same issue"

# --- I-0099: the source-equals-by pairing the die message describes ---
# The validator raises issues of its own, so source == issue-validator is
# the live case: --by issue-validator must be refused with nothing
# written and without the message prescribing that same command, while an
# independent identity must be accepted.
"$GOVCMD" issue new --type defect --source issue-validator --summary "raised by the validator itself" --fix F >/dev/null 2>&1
IVSELF=$(jq -r '[.entries[] | select(.source=="issue-validator")][0].id' "$SANDBOX/governance/issues.json")
OUT=$("$GOVCMD" issue validate "$IVSELF" --verdict reproduced --evidence E --by issue-validator 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "the validator must not certify its own report — rc=$RC: $OUT"
printf '%s' "$OUT" | grep -qF -- '--by issue-validator' \
  && bad "the refusal prescribed the exact command it refused (I-0099): $OUT" || ok
printf '%s' "$OUT" | grep -q 'debugger' \
  && ok || bad "the refusal must name a different read-only identity to dispatch: $OUT"
jq -e --arg i "$IVSELF" '[.entries[] | select(.id==$i and .validation==null)] | length == 1' \
  "$SANDBOX/governance/issues.json" >/dev/null \
  && ok || bad "a refused self-validation must write nothing"
expect_out "$IVSELF validated: reproduced" "an independent identity validates the validator's own report" \
  "$GOVCMD" issue validate "$IVSELF" --verdict reproduced --evidence E --repro-cmd "sh run.sh" --by debugger

# --- I-0099: the promotion lane says the same supported thing ---------
"$GOVCMD" issue new --type defect --source debugger --summary "unvalidated, for promotion" --fix F >/dev/null 2>&1
UNVAL=$(jq -r '[.entries[] | select(.source=="debugger")][0].id' "$SANDBOX/governance/issues.json")
OUT=$("$GOVCMD" task new --title T --check C --issue "$UNVAL" 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "task new on an unvalidated issue must be refused — rc=$RC: $OUT"
printf '%s' "$OUT" | grep -qF 'an unvalidated issue is not backlog work' \
  && ok || bad "the promotion refusal must keep its stated reason: $OUT"
printf '%s' "$OUT" | grep -qF -- '--by issue-validator' \
  && bad "the promotion refusal must not prescribe --by issue-validator (I-0099): $OUT" || ok
printf '%s' "$OUT" | grep -q 'read-only agent' \
  && ok || bad "the promotion refusal must name the supported path — dispatch a different read-only identity: $OUT"

# User is exempt: a human validating their own report is the authority
# the gate defers to, not a bypass of it
"$GOVCMD" issue new --type defect --source User --summary "raised by User" --fix F >/dev/null 2>&1
DSELF=$(jq -r '[.entries[] | select(.source=="User")][0].id' "$SANDBOX/governance/issues.json")
"$GOVCMD" issue validate "$DSELF" --verdict evidenced --evidence E --by User >/dev/null 2>&1 \
  && ok || bad "User must be exempt from the disjointness rule"

# governance-validate reports the historical rows at WARN, never FAIL:
# f() counts and exits 1, and a machine consumer pipes --porcelain into
# scrumux issue, so failing here would turn the repo red AND mint an issue
# per historical row
# scrumux now REFUSES to create such a row, so the fixture injects one
# directly — this is legacy data, which is exactly what the sweep is for
jq '.entries |= map(if .source=="audit-agent" then .validation.by = "audit-agent" else . end)' \
  "$SANDBOX/governance/issues.json" > "$SANDBOX/i.tmp" && mv "$SANDBOX/i.tmp" "$SANDBOX/governance/issues.json"
# T-0100: this legacy row is injected by hand, which also breaks the
# content seal. Reseal so the assertion below tests the self-validation
# sweep rather than the tamper check that now sits beside it.
rm -f "$GOV_ROOT/governance/seals.json"
"$ROOT/.deploy-claude/scripts/scrumux" repair journal log.json \
  --apply '.' --why 'reseal after a fixture edit' --by tests >/dev/null 2>&1 || true
OUT=$(cd "$ROOT" && .deploy-claude/scripts/scrumux records check 2>&1); RC=$?
printf '%s' "$OUT" | grep -qE 'WARN +self-validated issues' \
  && ok || bad "self-validated rows must be surfaced at WARN: $(printf '%s' "$OUT" | tail -3)"
# I-0099: the remedy the WARN names must be a route scrumux will accept. It
# used to say "re-validate via the issue-validator agent", which scrumux
# refuses outright for any row the validator itself raised.
printf '%s' "$OUT" | grep -qF 'via the issue-validator agent' \
  && bad "the WARN must not prescribe a single fixed validator identity (I-0099): $(printf '%s' "$OUT" | grep 'self-validated')" || ok
printf '%s' "$OUT" | grep -q "self-validated issues.*NOT that row's own source" \
  && ok || bad "the WARN must name dispatching an identity other than the row's source: $(printf '%s' "$OUT" | grep 'self-validated')"
[ $RC -eq 0 ] && ok || bad "the retrospective sweep must not fail the repo — rc=$RC"
OUT=$(cd "$ROOT" && .deploy-claude/scripts/scrumux records check --json 2>&1)
# It IS in the object, as a WARN row — which is the point: a machine
# consumer reads the TIER rather than guessing from prose, and a warn row
# is not a finding. Under --porcelain the only way to keep it out of a
# consumer's hands was to omit it entirely, so the fact was visible to
# humans and invisible to machines. Now both see it, correctly labelled.
printf '%s' "$OUT" | jq -e '[.checks[] | select(.tier == "fail") | select(.name | test("self-validated"))] | length == 0' >/dev/null 2>&1 \
  && ok || bad "a machine consumer must not see a historical row as a FINDING — it would mint one issue per row"
printf '%s' "$OUT" | jq -e '[.checks[] | select(.tier == "warn") | select(.name | test("self-validated"))] | length == 1' >/dev/null 2>&1 \
  && ok || bad "the retrospective observation must still REACH a machine consumer, as a warn row: $(printf '%s' "$OUT" | jq -c '[.checks[]|select(.name|test("self-validated"))]')"

printf 'issue-validate-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
