#!/bin/sh
# session-check-tests.sh — the close is six deterministic checks and
# nothing else. Each of the six is the way a green receipt can lie, or an
# irreversible state; each is proved here to FAIL when it should and to
# stay silent when it should not.
#
# Equally load-bearing: the checks this close NO LONGER makes. Bookkeeping
# is a harness problem, not a task problem, and four of six acceptance
# runs died on it while the code was correct every time. The negative
# assertions at the end keep it out.
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
VERIFY="$ROOT/.deploy-claude/scripts/scrumux"
VERIFY_CMD="task verify"
CHECK="$ROOT/.deploy-claude/scripts/scrumux"
CHECK_CMD="session check"
SANDBOX=$(mktemp -d) || { echo "session-check-tests: error: cannot create sandbox — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"
# A suite owns its own environment: these run as registered repo-health
# checks, so they must not inherit the outer run's guard.
unset HARNESS_IN_HEALTH_CHECKS

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

TODAY=$(date +%F)
TJ="$SANDBOX/governance/tasks.json"   # journals live under governance/ (lib.sh:28)

# fixture: a git repo, a ratified sprint, one task with an order that
# names a real file and a verification command that passes.
(cd "$SANDBOX" && git init -q -b main)
"$GOVCMD" feature new --name F --desc D >/dev/null
"$GOVCMD" story new --feature F-0001 --narrative N --criterion C >/dev/null
"$GOVCMD" epic new --name E --desc D --feature F-0001 >/dev/null
"$GOVCMD" task new --title T --check AC --feature F-0001 --story S-0001 >/dev/null
"$GOVCMD" task order T-0001 --scope S --verify true --out O \
  --file "pkg/a.txt | the file this task changes" >/dev/null
"$GOVCMD" sprint new --epic E-0001 >/dev/null
"$GOVCMD" sprint add SP-0001 T-0001 >/dev/null
"$GOVCMD" sprint ratify SP-0001 --by tester --authority direct >/dev/null
mkdir -p "$SANDBOX/pkg"; printf 'a\n' > "$SANDBOX/pkg/a.txt"

# --- 1. receipt present: a task claiming done with none FAILs ---------
"$GOVCMD" task status T-0001 in_progress >/dev/null
"$GOVCMD" task status T-0001 in_review >/dev/null 2>&1
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1); RC=$?
printf '%s' "$OUT" | grep -qE '^  FAIL +receipt present ' \
  && ok || bad "a task claiming done with no receipt must FAIL; got: $(printf '%s' "$OUT" | grep -i receipt | head -2)"
[ "$RC" -ne 0 ] && ok || bad "a missing receipt must refuse the close (exit non-zero); got rc=$RC"

# --- the message states the problem and stops -------------------------
# It must not hand the agent a governance command to run. That string is
# how a close becomes a governance sub-project.
printf '%s' "$OUT" | grep -A1 'receipt present' | grep -qE 'scrumux (log|task|issue|sprint|accept)' \
  && bad "the close must not prescribe a governance command; got: $(printf '%s' "$OUT" | grep -A1 'receipt present')" || ok

# --- 2. a green receipt passes ----------------------------------------
(cd "$SANDBOX" && "$VERIFY" $VERIFY_CMD T-0001 >/dev/null 2>&1)
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  ok +receipt green ' \
  && ok || bad "a green receipt must PASS; got: $(printf '%s' "$OUT" | grep 'receipt green')"

# --- 3. a red receipt FAILs -------------------------------------------
jq '.entries |= map(if .id=="T-0001" then .receipt.rc=1 else . end)' \
   "$TJ" > "$SANDBOX/.t" && mv "$SANDBOX/.t" "$TJ"
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  FAIL +receipt green ' \
  && ok || bad "a red receipt must FAIL the close"
jq '.entries |= map(if .id=="T-0001" then .receipt.rc=0 else . end)' \
   "$TJ" > "$SANDBOX/.t" && mv "$SANDBOX/.t" "$TJ"

# --- 4. command match: a verify run against something easier ----------
jq '.entries |= map(if .id=="T-0001" then .receipt.command="echo easier" else . end)' \
   "$TJ" > "$SANDBOX/.t" && mv "$SANDBOX/.t" "$TJ"
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  FAIL +command match ' \
  && ok || bad "a receipt whose command is not the order's must FAIL; got: $(printf '%s' "$OUT" | grep 'command match')"
jq '.entries |= map(if .id=="T-0001" then .receipt.command="true" else . end)' \
   "$TJ" > "$SANDBOX/.t" && mv "$SANDBOX/.t" "$TJ"

# --- 5. receipt fresh: verified, then kept typing ----------------------
# The failure nothing else sees. The receipt stands; the file moves after it.
sleep 1; printf 'edited after the receipt\n' >> "$SANDBOX/pkg/a.txt"
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  FAIL +receipt fresh ' \
  && ok || bad "a file edited after its receipt must FAIL; got: $(printf '%s' "$OUT" | grep 'receipt fresh')"

# a receipt with no epoch stamp cannot be judged, and must say so rather
# than guessing either way
jq '.entries |= map(if .id=="T-0001" then (.receipt |= del(.at_epoch)) else . end)' \
   "$TJ" > "$SANDBOX/.t" && mv "$SANDBOX/.t" "$TJ"
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  WARN +receipt fresh ' \
  && ok || bad "an unstamped receipt must WARN, never FAIL or silently PASS; got: $(printf '%s' "$OUT" | grep 'receipt fresh')"
(cd "$SANDBOX" && "$VERIFY" $VERIFY_CMD T-0001 >/dev/null 2>&1)

# --- 6. checks ran: the most dangerous green --------------------------
jq '.entries |= map(if .id=="T-0001" then .receipt.checks_run=0 else . end)' \
   "$TJ" > "$SANDBOX/.t" && mv "$SANDBOX/.t" "$TJ"
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  FAIL +checks ran ' \
  && ok || bad "checks_run=0 is a green that proved nothing and must FAIL"

# task-verify counts the order's own command, so an honest verify is
# never 0 even where no repo-health check is registered — which is every
# deployed repo.
(cd "$SANDBOX" && "$VERIFY" $VERIFY_CMD T-0001 >/dev/null 2>&1)
N=$(jq -r '[.entries[]|select(.id=="T-0001")][0].receipt.checks_run' "$TJ")
[ "$N" -ge 1 ] \
  && ok || bad "an honest verify must report checks_run>=1 with no fleet registered; got $N"

# --- 7. nothing mid-flight --------------------------------------------
"$GOVCMD" task status T-0001 in_progress >/dev/null 2>&1
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  FAIL +nothing mid-flight ' \
  && ok || bad "a task left in_progress at the close must FAIL"

# --- 7b. D-0084: the close judges THIS session's task -----------------
# With N>1 admitted per sprint, "no task left in_progress" stopped being a
# fact about the session and became a fact about the repo: a second agent
# still working would have failed the first one's close. The env the app
# sets at spawn names the task this session was dispatched under; that one
# FAILs, and the others are named as a WARN so nothing goes unsaid.
"$GOVCMD" task new --title T2 --check AC2 --feature F-0001 --story S-0001 >/dev/null 2>&1
OUT=$(cd "$SANDBOX" && SCRUMUX_TASK=T-0001 "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  FAIL +nothing mid-flight ' \
  && ok || bad "the session's OWN task left in_progress must still FAIL the close: $(printf '%s' "$OUT" | grep 'mid-flight')"
OUT=$(cd "$SANDBOX" && SCRUMUX_TASK=T-0002 "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  FAIL +nothing mid-flight ' \
  && bad "another session's in-flight task must not FAIL this session's close (D-0084): $(printf '%s' "$OUT" | grep 'mid-flight')" || ok
printf '%s' "$OUT" | grep -qE '^  WARN +nothing mid-flight .*T-0001' \
  && ok || bad "the other session's task must still be NAMED, as a WARN: $(printf '%s' "$OUT" | grep 'mid-flight')"
# A hand session names no task, and keeps the old all-or-nothing answer.
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  FAIL +nothing mid-flight ' \
  && ok || bad "with no SCRUMUX_TASK the close must keep today's behaviour: $(printf '%s' "$OUT" | grep 'mid-flight')"

# --- 8. strays/secrets ------------------------------------------------
printf 'SECRET=x\n' > "$SANDBOX/.env"
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)
printf '%s' "$OUT" | grep -qE '^  FAIL +strays/secrets ' \
  && ok || bad "a secret-shaped file must FAIL"
rm -f "$SANDBOX/.env"

# --- 9. the checks that are GONE, and must stay gone ------------------
# Every one of these blocked a close over bookkeeping while the code was
# correct. They are User-inspection data now, never an agent's block.
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1)

printf '%s' "$OUT" | grep -q 'diff within scope' \
  && bad "diff-within-scope is back — it failed every recorded acceptance run and prevented nothing" || ok

printf '%s' "$OUT" | grep -q 'no silent finishes' \
  && bad "the scrumux log narration check is back — the finished task and the close review are the documentation" || ok

printf '%s' "$OUT" | grep -qE 'views (regenerate|fresh)' \
  && bad "the views checks are back in the close — a stale generated view is a harness problem, not a task problem" || ok

printf '%s' "$OUT" | grep -q '\[MANUAL\]' \
  && bad "a MANUAL prompt is back — the close is deterministic or it is not a close" || ok

# gate emission: nothing read the 251 rows, and 0 came from any wall
grep -q 'scrumux" gate\|scrumux gate' "$CHECK" \
  && bad "session-check is emitting gate rows again — nothing reads them" || ok

# --- 10. a clean session closes ---------------------------------------
"$GOVCMD" task status T-0001 in_review >/dev/null 2>&1
(cd "$SANDBOX" && "$VERIFY" $VERIFY_CMD T-0001 >/dev/null 2>&1)
(cd "$SANDBOX" && git add -A >/dev/null 2>&1)
OUT=$(cd "$SANDBOX" && "$CHECK" $CHECK_CMD 2>&1); RC=$?
[ "$RC" -eq 0 ] \
  && ok || bad "a session with a green, fresh, matching receipt must close clean; rc=$RC, fails: $(printf '%s' "$OUT" | grep '^\[FAIL\]')"


# --- PK-3 (D-0085): the close's secret gate must RUN inside a worktree ---
# `.git` is a FILE in a git worktree, not a directory, so `[ -d "$ROOT/.git" ]`
# is false there and section 5 reported "not a git repo" instead of looking.
# That is the ONE irreversible check in the close (a committed secret cannot
# be un-published), and D-0084's parallel dispatch puts sessions in worktrees
# by design -- so the check was off in exactly the configuration built to be
# used. Measured: git status inside the worktree does see the stray, so only
# the gate was wrong.
(cd "$SANDBOX" && git add -A >/dev/null 2>&1 \
  && git -c user.email=t@t -c user.name=t commit -qm fixture >/dev/null 2>&1)
WT="$SANDBOX/wt"
if (cd "$SANDBOX" && git worktree add -q "$WT" -b wtbranch >/dev/null 2>&1) && [ -f "$WT/.git" ]; then
  mkdir -p "$WT/governance"
  printf 'SECRET=1\n' > "$WT/.env"
  OUTW=$(cd "$WT" && GOV_ROOT="$WT" WORK_ROOT="$WT" "$CHECK" $CHECK_CMD 2>&1)
  printf '%s' "$OUTW" | grep -q 'not a git repo' \
    && bad "PK-3: a worktree is a git repo — the stray/secret gate must not report 'not a git repo' (.git is a FILE there)" || ok
  printf '%s' "$OUTW" | grep -qE 'strays/secrets .*\.env' \
    && ok || bad "PK-3: a .env in a worktree must be caught by strays/secrets; got: $(printf '%s' "$OUTW" | grep -i 'stray' | head -2)"
  (cd "$SANDBOX" && git worktree remove --force "$WT" >/dev/null 2>&1) || rm -rf "$WT"
else
  bad "PK-3: could not build the worktree fixture (git worktree add failed)"
fi

printf 'session-check-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
