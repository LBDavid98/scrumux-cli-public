#!/bin/sh
# stub-lane-tests.sh — T-0038 acceptance: session-check's live-stub
# scan WARNs on a marker linked to an open issue (downstream work
# continues), FAILs on a marker whose issue is resolved/rejected/
# unknown, PASSes with no markers; the lane is documented in
# implement-sop; task-verify's gate stays stub-agnostic by design.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
CHECK="$ROOT/.deploy-claude/scripts/scrumux"
CHECK_CMD="session check"
SANDBOX=$(mktemp -d) || { echo "stub-lane-tests: error: cannot create sandbox — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"
# THE SANDBOX IS BOTH ROOTS HERE. Section 6b scans WORK_ROOT -- the CODE
# tree -- which since 8b8516a ("ROOT answered two questions, and moving one
# moved the other") resolves to the CALLER's git toplevel, i.e. the harness
# checkout. A fixture setting only GOV_ROOT therefore wrote its STUB markers
# where the scan never looked: case A ("clean tree") passed VACUOUSLY and
# B-G all read "no stub markers in live code". Bisected: 22/0 at 8b8516a^,
# 13/9 at 8b8516a. Declaring both roots is the shape the rest of the suite
# roster already uses.
export WORK_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# fixture: governance with one open, one accepted, one resolved,
# one rejected issue (I-0090 is deliberately absent = unknown)
mkdir -p "$SANDBOX/governance"
cat > "$SANDBOX/governance/issues.json" <<'EOF'
{"entries":[
 {"id":"I-0001","type":"defect","source":"t","summary":"open blocker","status":"open","created_at":"2026-08-18"},
 {"id":"I-0002","type":"defect","source":"t","summary":"accepted blocker","status":"accepted","created_at":"2026-08-18"},
 {"id":"I-0003","type":"defect","source":"t","summary":"closed blocker","status":"resolved","created_at":"2026-08-18"},
 {"id":"I-0004","type":"defect","source":"t","summary":"thrown-out blocker","status":"rejected","created_at":"2026-08-18"}
]}
EOF

# case A: no markers anywhere -> PASS line, exit 0
OUT=$("$CHECK" $CHECK_CMD 2>&1); RC=$?
printf '%s' "$OUT" | grep -q 'no stub markers in live code' && ok || bad "clean tree should PASS live stubs; got: $(printf '%s' "$OUT" | grep -A1 'live stubs')"
[ $RC -eq 0 ] && ok || bad "clean sandbox should exit 0, got $RC: $OUT"

# case B: markers on open + accepted issues -> WARN with count, exit 0
printf '# STUB(I-0001) parked on the open blocker\n# STUB(I-0002) parked on the accepted blocker\n' > "$SANDBOX/src.sh"
OUT=$("$CHECK" $CHECK_CMD 2>&1); RC=$?
printf '%s' "$OUT" | grep -q '2 live stub(s) parked on open issue(s): I-0001 I-0002' && ok || bad "open/accepted markers should WARN with count+ids; got: $(printf '%s' "$OUT" | grep -A1 'live stubs')"
[ $RC -eq 0 ] && ok || bad "live stubs on open issues must not block (want exit 0), got $RC"
printf '%s' "$OUT" | grep -qE 'WARN +live stubs' && ok || bad "live-stub result should be the WARN tier"

# case C: marker on a resolved issue -> FAIL by site, exit 1
printf '# STUB(I-0003) parked on the closed blocker\n' > "$SANDBOX/src.sh"
OUT=$("$CHECK" $CHECK_CMD 2>&1); RC=$?
printf '%s' "$OUT" | grep -q 'resolved/rejected/unknown' && ok || bad "resolved-issue marker should FAIL with the resolved/rejected/unknown clause"
printf '%s' "$OUT" | grep -q 'src.sh:1->I-0003(resolved)' && ok || bad "FAIL should name site and status; got: $(printf '%s' "$OUT" | grep -A1 'live stubs')"
[ $RC -eq 0 ] && ok || bad "resolved-issue marker should now exit 0 — T-0144 moved section 6b to the WARN tier; the marker is still NAMED, it just no longer blocks the commit (got $RC)"

# case D: marker on a rejected issue -> FAIL
printf '# STUB(I-0004) parked on the thrown-out blocker\n' > "$SANDBOX/src.sh"
OUT=$("$CHECK" $CHECK_CMD 2>&1); RC=$?
printf '%s' "$OUT" | grep -q 'src.sh:1->I-0004(rejected)' && ok || bad "rejected-issue marker should FAIL by site"
[ $RC -eq 0 ] && ok || bad "rejected-issue marker should now exit 0 — T-0144 moved section 6b to the WARN tier; the marker is still NAMED, it just no longer blocks the commit (got $RC)"

# case E: marker on an unknown issue -> FAIL
printf '# STUB(I-0090) parked on nothing\n' > "$SANDBOX/src.sh"
OUT=$("$CHECK" $CHECK_CMD 2>&1); RC=$?
printf '%s' "$OUT" | grep -q 'src.sh:1->I-0090(unknown)' && ok || bad "unknown-issue marker should FAIL by site"
[ $RC -eq 0 ] && ok || bad "unknown-issue marker should now exit 0 — T-0144 moved section 6b to the WARN tier; the marker is still NAMED, it just no longer blocks the commit (got $RC)"

# case F: mixed live + dead -> FAIL wins, live still surfaced
printf '# STUB(I-0001) still parked\n# STUB(I-0003) gone stale\n' > "$SANDBOX/src.sh"
OUT=$("$CHECK" $CHECK_CMD 2>&1); RC=$?
printf '%s' "$OUT" | grep -q 'src.sh:2->I-0003(resolved)' && ok || bad "mixed: stale marker should FAIL by site"
printf '%s' "$OUT" | grep -q '1 live stub(s) parked on open issue(s): I-0001' && ok || bad "mixed: live marker should still WARN"
[ $RC -eq 0 ] && ok || bad "mixed should now exit 0 — T-0144 moved section 6b to the WARN tier; the marker is still NAMED, it just no longer blocks the commit (got $RC)"
rm -f "$SANDBOX/src.sh"

# case G: two markers on one physical line both count
printf '# STUB(I-0001) and STUB(I-0002) parked together\n' > "$SANDBOX/src.sh"
OUT=$("$CHECK" $CHECK_CMD 2>&1); RC=$?
printf '%s' "$OUT" | grep -q '2 live stub(s) parked on open issue(s): I-0001 I-0002' && ok || bad "two markers on one line should both count; got: $(printf '%s' "$OUT" | grep -A1 'live stubs')"
[ $RC -eq 0 ] && ok || bad "same-line live markers must not block, got $RC"
rm -f "$SANDBOX/src.sh"

# --- documentation clauses (D-0015: lane lives in implement-sop) -----
SOP="$ROOT/.deploy-claude/skills/implement-sop/SKILL.md"
grep -q 'STUB(I-XXXX)' "$SOP" && ok || bad "implement-sop must document the marker grammar"
grep -q 'D-0015' "$SOP" && ok || bad "implement-sop must cite D-0015"
grep -q 'D-0019' "$SOP" && ok || bad "implement-sop must settle standard-6 interplay by citing D-0019"
grep -q 'task-verify may pass with a marked stub' "$SOP" && ok || bad "implement-sop must state pass-with-stub"
grep -q 'D-0015' "$ROOT/src/nouns/task/verify.ts" && ok || bad "task verify must note pass-with-stub is deliberate (D-0015)"

printf 'stub-lane-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "stub-lane-tests: error: $FAIL case(s) wrong — fix the 6b live-stub scan in .claude/scripts/scrumux session check (or the implement-sop lane docs) before trusting parked stubs" >&2
  exit 1
fi
exit 0
