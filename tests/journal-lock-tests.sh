#!/bin/sh
# journal-lock-tests.sh — T-0128/I-0079: journal writes are serialised
# and ids are allocated inside the same critical section.
#
# I-0079 measured the failure this closes: two concurrent `scrumux task new`
# both printed T-0128, the journal grew by ONE instead of two, and BOTH
# callers were told their record was created. The seal could not see it
# (reseal_one hashes whatever is on disk, so the winner certifies the
# truncated file), so the loss was permanent and invisible.
# GOV_ROOT sandbox. Run: sh tests/journal-lock-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
SANDBOX=$(mktemp -d) || { echo "journal-lock-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

count() { [ -f "$SANDBOX/governance/$1" ] && jq '.entries | length' "$SANDBOX/governance/$1" || echo 0; }

# seed so the journals exist and ids do not start from scratch each race
"$GOVCMD" task new --title seed --check seed >/dev/null 2>&1

# --- 1. two concurrent scrumux task new: both survive, ids differ ---------
# The acceptance check for T-0128, run five times because I-0079 was
# reproduced 5/5 and a single green run proves nothing about a race.
i=0
while [ "$i" -lt 5 ]; do
  i=$((i + 1))
  before=$(count tasks.json)
  "$GOVCMD" task new --title "race $i A" --check a >"$SANDBOX/a.out" 2>&1 &
  pa=$!
  "$GOVCMD" task new --title "race $i B" --check b >"$SANDBOX/b.out" 2>&1 &
  pb=$!
  wait "$pa"; ra=$?
  wait "$pb"; rb=$?
  after=$(count tasks.json)
  ida=$(tail -1 "$SANDBOX/a.out"); idb=$(tail -1 "$SANDBOX/b.out")

  [ "$ra" -eq 0 ] && [ "$rb" -eq 0 ] || bad "trial $i: a caller exited non-zero (a=$ra b=$rb)"
  [ "$ra" -eq 0 ] && [ "$rb" -eq 0 ] && ok

  if [ "$ida" = "$idb" ]; then
    bad "trial $i: both callers were handed the SAME id ($ida) — next_id ran outside the lock"
  else ok; fi

  if [ "$((after - before))" -eq 2 ]; then ok; else
    bad "trial $i: journal grew by $((after - before)), expected 2 — a record was lost silently"
  fi

  jq -e --arg t "race $i A" '[.entries[] | select(.title == $t)] | length == 1' \
    "$SANDBOX/governance/tasks.json" >/dev/null 2>&1 || bad "trial $i: 'race $i A' is missing"
  jq -e --arg t "race $i B" '[.entries[] | select(.title == $t)] | length == 1' \
    "$SANDBOX/governance/tasks.json" >/dev/null 2>&1 || bad "trial $i: 'race $i B' is missing"
  ok
done

# --- 2. a second allocator races too (the bug was never task-only) ----
# Eleven allocators share the shape; issue is checked so a fix that
# special-cases cmd_task cannot pass.
before=$(count issues.json)
"$GOVCMD" issue new --type idea --source User --summary "race issue A" --fix f >"$SANDBOX/ia.out" 2>&1 &
pa=$!
"$GOVCMD" issue new --type idea --source User --summary "race issue B" --fix f >"$SANDBOX/ib.out" 2>&1 &
pb=$!
wait "$pa"; wait "$pb"
after=$(count issues.json)
[ "$((after - before))" -eq 2 ] && ok || bad "scrumux issue race: journal grew by $((after - before)), expected 2"
[ "$(tail -1 "$SANDBOX/ia.out")" != "$(tail -1 "$SANDBOX/ib.out")" ] && ok \
  || bad "scrumux issue race: both callers were handed the same id"

# --- 3. the lock is always released -----------------------------------
"$GOVCMD" task new --title "lock release" --check c >/dev/null 2>&1
if find "$SANDBOX/governance" -name '*.lock' 2>/dev/null | grep -q .; then
  bad "a .lock directory survived a successful write — the lock leaks"
else ok; fi

# --- 4. a stale lock fails loudly and names how to clear it -----------
# A crashed writer must not wedge the repo silently: the message has to
# name the lock directory, because that is the only way out.
mkdir -p "$SANDBOX/governance/tasks.json.lock"
out=$(JOURNAL_LOCK_TRIES=2 "$GOVCMD" task new --title "stale" --check c 2>&1); rc=$?
[ "$rc" -ne 0 ] && ok || bad "a stale lock did not fail the write"
printf '%s' "$out" | grep -q 'tasks.json.lock' && ok \
  || bad "the stale-lock message does not name the lock directory: $out"
rmdir "$SANDBOX/governance/tasks.json.lock" 2>/dev/null || :

printf 'journal-lock-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || { echo "journal-lock-tests: error: $FAIL case(s) wrong — concurrent scrumux writes are losing records or duplicating ids (I-0079); fix .claude/scripts/lib.sh journal_lock/append_with_id before trusting any parallel work" >&2; exit 1; }
