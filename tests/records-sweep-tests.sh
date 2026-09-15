#!/bin/sh
# records-sweep-tests.sh — T-0042: the planning-entry sweep.
# scrumux status sweep lists exactly the open issues with neither
# validation nor authorization. The sweep itself is User-inspection
# surface (D-0073); what the session-open skill still owes is the
# PROMOTION contract — an issue does not become a task without an
# independently recorded verdict (T-0189). Also records-check's repo-health sweep (T-0185): a
# registered check whose command file is missing FAILs, and the removed
# §9b registration ratchet stays removed.
# GOV_ROOT sandbox. Run: sh tests/records-sweep-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
SWEEP="$ROOT/.deploy-claude/scripts/scrumux"
SWEEP_CMD="status"
SKILL="$ROOT/.deploy-claude/skills/session-open/SKILL.md"
SANDBOX=$(mktemp -d) || { echo "records-sweep-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# --- empty sandbox ----------------------------------------------------
OUT=$("$SWEEP" $SWEEP_CMD sweep 2>&1); rc=$?
[ $rc -eq 0 ] && printf '%s' "$OUT" | grep -q 'pending: 0' && ok || bad "empty repo — rc=$rc: $OUT"

# --- fixtures: four issues in distinct gate states -------------------
"$GOVCMD" issue new --type defect --source claude --summary "unvalidated open" --fix F --severity high >/dev/null 2>&1   # I-0001
"$GOVCMD" issue new --type defect --source claude --summary "validated open" --fix F >/dev/null 2>&1                     # I-0002
"$GOVCMD" issue new --type defect --source claude --summary "authorized open" --fix F >/dev/null 2>&1                    # I-0003
"$GOVCMD" issue new --type defect --source claude --summary "resolved one" --fix F >/dev/null 2>&1                       # I-0004
"$GOVCMD" issue validate I-0002 --verdict evidenced --evidence E >/dev/null 2>&1
"$GOVCMD" issue authorize I-0003 --by User >/dev/null 2>&1
"$GOVCMD" issue update I-0004 --status resolved >/dev/null 2>&1

# --- only the truly-pending issue lists ------------------------------
OUT=$("$SWEEP" $SWEEP_CMD sweep 2>&1); rc=$?
[ $rc -eq 0 ] && ok || bad "sweep exits 0 — rc=$rc"
printf '%s\n' "$OUT" | grep -q '^I-0001 high unvalidated open' && ok || bad "pending line format/content — got: $OUT"
printf '%s' "$OUT" | grep -q 'I-0002' && bad "validated issue wrongly pending" || ok
printf '%s' "$OUT" | grep -q 'I-0003' && bad "authorized issue wrongly pending (I-0010: authorization passes the gate)" || ok
printf '%s' "$OUT" | grep -q 'I-0004' && bad "non-open issue wrongly pending" || ok
printf '%s' "$OUT" | grep -q 'pending: 1' && ok || bad "count line — got: $OUT"
printf '%s' "$OUT" | grep -q 'issue-validator' && ok || bad "nonzero count names the validator dispatch"

# --- ruling clears the list ------------------------------------------
"$GOVCMD" issue validate I-0001 --verdict invalidated --evidence "disproof" >/dev/null 2>&1
OUT=$("$SWEEP" $SWEEP_CMD sweep 2>&1)
printf '%s' "$OUT" | grep -q 'pending: 0' && ok || bad "ruled issue leaves the list — got: $OUT"

# --- registry command files exist (records-check §9a) ---------------------
# T-0185 (D-0074) removed §9b, the registration ratchet that named every
# unregistered tests/*-tests.sh, and put a real FAIL in its place: a
# check REGISTERED in repo-health.json whose command points at a file
# that is not on disk is a gate that cannot run. run_health_checks cds
# to $ROOT and the command dies on the missing file, so the repo reports
# ill-health for a reason that has nothing to do with the repo.
#
# Both directions are asserted: the missing file FAILS and names the
# entry, and the same registry with the file present is silent. Section 9
# (an entry missing name or command) still fails alongside it.
GV="$ROOT/.deploy-claude/scripts/scrumux"
GV_CMD="records check"
mkdir -p "$SANDBOX/tests"
# repo-health.json is written by hand here, so the seal file goes with
# each write — otherwise the next hand-write trips records-check's
# outside-gov-edit FAIL and the exit code under test measures the
# fixture rather than §9a.
set_health() { printf '%s\n' "$1" > "$SANDBOX/governance/repo-health.json"; rm -f "$SANDBOX/governance/seals.json"; }

# --- a registered suite whose file is gone FAILS ----------------------
set_health '{"entries":[{"name":"zz-gone-tests","command":"sh tests/zz-gone-tests.sh","type":"test","timeout_seconds":120}]}'
GVOUT=$("$GV" $GV_CMD 2>&1); gvrc=$?
[ $gvrc -eq 1 ] && ok || bad "a registered check whose file is missing must FAIL records-check — rc=$gvrc: $GVOUT"
printf '%s\n' "$GVOUT" | grep -qE "FAIL +repo-health: check 'zz-gone-tests'" \
  && ok || bad "§9a must name the offending ENTRY — got: $GVOUT"
printf '%s\n' "$GVOUT" | grep -q 'tests/zz-gone-tests.sh is not on disk' \
  && ok || bad "§9a must name the missing PATH — got: $GVOUT"
printf '%s\n' "$GVOUT" | grep -qF 'scrumux repair journal repo-health.json' \
  && ok || bad "§9a must carry the fix (de-register or restore) — got: $GVOUT"
printf '%s\n' "$GVOUT" | grep -q 'clean' \
  && bad "a run with a broken registered gate must not report clean — got: $GVOUT" || ok

# --- and it reaches the MACHINE output: a finding, not an advisory ----
# A machine consumer pipes findings into `scrumux issue new`; a gate that
# cannot run is exactly the drift that channel is for. That output used
# to be --porcelain, a TSV format invented because --json was available
# to nothing but `harness`. --json now carries every finding as a row
# with its own tier, name and fix, so the second format is gone.
PORC=$("$GV" $GV_CMD --json 2>&1); prc=$?
[ $prc -eq 1 ] && ok || bad "--json must carry the same nonzero exit — rc=$prc: $PORC"
printf '%s\n' "$PORC" | jq -e 'any(.checks[]; .tier == "fail" and (.name | test("zz-gone-tests")))' >/dev/null 2>&1 \
  && ok || bad "§9a finding must reach --json as a fail row — got: $PORC"
printf '%s\n' "$PORC" | jq -e '.ok == false and .exit == 1' >/dev/null 2>&1 \
  && ok || bad "--json must report ok:false and exit:1 alongside the finding — got: $PORC"

# --- the same registry with the file present is silent ----------------
printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/tests/zz-gone-tests.sh"
GVOUT=$("$GV" $GV_CMD 2>&1); gvrc=$?
[ $gvrc -eq 0 ] && ok || bad "a registered check whose file EXISTS must pass — rc=$gvrc: $GVOUT"
printf '%s\n' "$GVOUT" | grep -q 'zz-gone-tests' \
  && bad "a present file must produce no §9a line — got: $GVOUT" || ok

# --- the .claude/scripts/<name> shape is checked too ------------------
# The registry holds five lint entries of this shape; `sh <path>` is not
# the only form that can rot.
set_health '{"entries":[{"name":"zz-lint","command":".claude/scripts/zz-missing --flag","type":"lint","timeout_seconds":60}]}'
GVOUT=$("$GV" $GV_CMD 2>&1); gvrc=$?
[ $gvrc -eq 1 ] && ok || bad "a lint entry pointing at a missing script must FAIL — rc=$gvrc: $GVOUT"
printf '%s\n' "$GVOUT" | grep -q "check 'zz-lint'" \
  && ok || bad "the .claude/scripts/<name> shape is not path-checked — got: $GVOUT"
mkdir -p "$SANDBOX/.claude/scripts"
printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/.claude/scripts/zz-missing"
GVOUT=$("$GV" $GV_CMD 2>&1); gvrc=$?
[ $gvrc -eq 0 ] && ok || bad "a present script (args ignored) must pass — rc=$gvrc: $GVOUT"

# --- the removed §9b ratchet must not come back -----------------------
# An unregistered tests/*-tests.sh is no longer records-check's business
# (D-0074): coverage of which suites a change should run belongs to the
# coverage lens.
printf '#!/bin/sh\nexit 0\n' > "$SANDBOX/tests/zz-orphan-tests.sh"
set_health '{"entries":[]}'
GVOUT=$("$GV" $GV_CMD 2>&1); gvrc=$?
[ $gvrc -eq 0 ] && ok || bad "an unregistered suite must not affect records-check at all — rc=$gvrc: $GVOUT"
printf '%s\n' "$GVOUT" | grep -q 'zz-orphan-tests' \
  && bad "the §9b registration ratchet is back — T-0185/D-0074 removed it; got: $GVOUT" || ok
printf '%s\n' "$GVOUT" | grep -q 'has no repo-health entry' \
  && bad "the §9b advisory line is back — got: $GVOUT" || ok

# --- section 9 still FAILS: a malformed entry is a broken gate --------
set_health '{"entries":[{"name":"zz-orphan-tests","type":"test"}]}'
GVOUT=$("$GV" $GV_CMD 2>&1); gvrc=$?
[ $gvrc -eq 1 ] && ok || bad "a repo-health entry with no command must still fail (section 9 did not move) — rc=$gvrc"
printf '%s\n' "$GVOUT" | grep -q 'repo-health: check missing name or command' \
  && ok || bad "section 9's finding is missing — got: $GVOUT"

rm -rf "$SANDBOX/tests" "$SANDBOX/.claude" "$SANDBOX/governance/repo-health.json"

# --- journals past ARG_MAX still records-check (T-0193, I-0116) ------------
# The cross-journal checks need the OTHER journals inside the jq program,
# and they used to arrive as --argjson: whole file bodies, on the command
# line. Command lines are capped. At the HEAD that raised I-0116 the five
# bodies section 1 passed measured 1,062,958 bytes against an ARG_MAX of
# 1,048,576, so /usr/bin/jq never exec'd — count_sweep reported
# "validator internal ... do not trust this run", records-check exited 1, and
# because records-check is a type=lint entry in repo-health.json that landed on
# EVERY task-verify in the repo. The journals only grow, so nothing about
# it was going to get better on its own.
#
# This case is the ceiling test the old arrangement could not have passed:
# two synthetic journals about 5.6MB each, together an order of magnitude
# past the byte count that broke it. Two assertions, and the second is the
# load-bearing one — "no argv error" alone would also be satisfied by a
# records-check that read nothing. A log entry pointing at a task id that is
# NOT in the 5.6MB tasks.json must still be caught, which is only possible
# if the whole of tasks.json genuinely reached jq.
BIGROOT="$SANDBOX/big"
mkdir -p "$BIGROOT/governance"
awk 'BEGIN{
  pad=""; for (i = 0; i < 1000; i++) pad = pad "x";
  printf "{\"entries\":[";
  for (i = 1; i <= 5200; i++) {
    if (i > 1) printf ",";
    printf "{\"id\":\"T-%04d\",\"title\":\"synthetic task %d\",\"acceptance_check\":\"%s\",\"status\":\"proposed\",\"created_at\":\"2026-01-01\"}", i, i, pad;
  }
  printf "]}\n";
}' > "$BIGROOT/governance/tasks.json"
# entry 1 refers to T-9999, which does not exist; 2..5200 refer to tasks
# that do. Both directions are asserted below.
awk 'BEGIN{
  pad=""; for (i = 0; i < 1000; i++) pad = pad "y";
  printf "{\"entries\":[";
  for (i = 1; i <= 5200; i++) {
    if (i > 1) printf ",";
    t = sprintf("T-%04d", i); if (i == 1) t = "T-9999";
    printf "{\"id\":\"L-%04d\",\"date\":\"2026-01-01\",\"task\":\"%s\",\"actor\":\"tester\",\"title\":\"entry %d\",\"what_was_done\":\"%s\"}", i, t, i, pad;
  }
  printf "]}\n";
}' > "$BIGROOT/governance/log.json"

BIGBYTES=$(cat "$BIGROOT/governance/tasks.json" "$BIGROOT/governance/log.json" | wc -c | tr -d ' ')
[ "$BIGBYTES" -ge 10629580 ] && ok \
  || bad "the fixture is not big enough to be a ceiling test — $BIGBYTES bytes, want at least 10x the 1,062,958 that broke records-check"

BIGOUT=$(GOV_ROOT="$BIGROOT" "$GV" $GV_CMD 2>&1)
printf '%s\n' "$BIGOUT" | grep -q 'Argument list too long' \
  && bad "journal bodies are back on the jq command line — records-check hit ARG_MAX at $BIGBYTES bytes (I-0116); pass journals with --slurpfile, never --argjson" || ok
printf '%s\n' "$BIGOUT" | grep -q 'validator internal' \
  && bad "count_sweep could not run jq at $BIGBYTES bytes — got: $(printf '%s\n' "$BIGOUT" | grep 'validator internal')" || ok
printf '%s\n' "$BIGOUT" | grep -q 'log: L-0001 task ref T-9999 unresolved' && ok \
  || bad "the cross-journal check did not fire at $BIGBYTES bytes — records-check ran but the journals never reached jq, which reports clean and is worse than the crash it replaced. Got: $BIGOUT"
printf '%s\n' "$BIGOUT" | grep -q 'log: L-0002 task ref' \
  && bad "a log ref that DOES resolve was reported unresolved — the slurped tasks.json is being read wrong (--slurpfile wraps in an array; the program must unwrap it)" || ok

rm -rf "$BIGROOT"

# --- skill documents the PROMOTION contract --------------------------
# T-0189: the planning-entry sweep is gone — it was a cadence, and a
# cadence is the app's job (D-0073). The part that was load-bearing is
# not: an issue may not become a task until a verdict is on record, and
# the identity that records it must not be the one that raised it. That
# is the assertion below, and it is the one scrumux enforces at the write.
grep -q 'scrumux issue validate' "$SKILL" \
  && ok || bad "session-open must name the records-check command an issue passes through before it becomes a task"
grep -q 'issue-validator' "$SKILL" && ok || bad "session-open names the validator agent"
grep -q 'memory-append' "$SKILL" && ok || bad "session-open records the validator's memory block"
grep -q 'scrumux memory' "$SKILL" \
  && ok || bad "session-open must name scrumux memory — the validator is read-only and its memory persists no other way (T-0124)"
grep -q 'read-only' "$SKILL" \
  && ok || bad "session-open must say the validator is read-only, or the next session lets it record its own verdict (I-0054)"

# --- the rule names every gate that exists (T-0206 / I-0123) ----------
# The rule used to name ONE enforcing command while the code gated two,
# under-reporting its own enforcement — which is how a reader concludes
# the ordinary lane is ungated. Both directions are asserted: the rule
# names both commands, and each command it names really does refuse.
RULE="$ROOT/.deploy-claude/rules/issue-validation.md"
grep -q 'scrumux sprint new --hotfix --issue' "$RULE" \
  && ok || bad "the issue-validation rule must name the hotfix gate"
grep -q 'scrumux task new .*--issue' "$RULE" \
  && ok || bad "the issue-validation rule must name the task-new gate too — scrumux:480-490 enforces the identical check, and a rule that omits it under-reports its own enforcement (I-0123)"

# Now prove each named gate actually refuses, in a sandbox of its own so
# the ids below cannot collide with the cases above.
GB=$(mktemp -d) || { echo "records-sweep-tests: cannot mktemp" >&2; exit 1; }
mkdir -p "$GB/governance"
IID=$(GOV_ROOT="$GB" "$GOVCMD" issue new --type defect --source claude --summary "unvalidated on purpose" --fix "n/a" 2>&1)
GOUT=$(GOV_ROOT="$GB" "$GOVCMD" task new --title probe --check probe --issue "$IID" 2>&1); GRC=$?
[ "$GRC" -ne 0 ] \
  && ok || bad "scrumux task new --issue accepted an unvalidated issue — the rule names it as a gate, so it must refuse"
printf '%s' "$GOUT" | grep -qi 'valid' \
  && ok || bad "scrumux task new --issue refused but did not say why; got: $GOUT"
EID=$(GOV_ROOT="$GB" "$GOVCMD" epic new --name E --desc D 2>&1)
HOUT=$(GOV_ROOT="$GB" "$GOVCMD" sprint new --hotfix --issue "$IID" 2>&1); HRC=$?
[ "$HRC" -ne 0 ] \
  && ok || bad "scrumux sprint new --hotfix --issue accepted an unvalidated issue — the rule names it as a gate, so it must refuse"
# and once validated, the same command goes through: a gate that never
# opens is indistinguishable from a broken command.
GOV_ROOT="$GB" "$GOVCMD" issue validate "$IID" --verdict evidenced --evidence "cited" --by issue-validator >/dev/null 2>&1
VOUT=$(GOV_ROOT="$GB" "$GOVCMD" task new --title probe2 --check probe2 --issue "$IID" 2>&1); VRC=$?
[ "$VRC" -eq 0 ] \
  && ok || bad "scrumux task new --issue still refused a VALIDATED issue — the gate must open, not just close; got: $VOUT"
rm -rf "$GB"

printf 'records-sweep-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "records-sweep-tests: error: $FAIL assertion(s) failed — the planning-entry sweep regressed, or records-check's §9a registered-command-exists FAIL stopped catching a gate that cannot run (T-0185, D-0074); fix before planning" >&2
  exit 1
fi
exit 0
