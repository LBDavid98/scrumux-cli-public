#!/bin/sh
# scrumux-tests.sh — the harness's registered health check for scrumux (T-0016).
# Exercises every scrumux subcommand's happy path and guard in a disposable
# GOV_ROOT sandbox; the real governance/ journals are never touched.
# Exit 0 = healthy; nonzero = regression, with each failing assertion
# named. Run from the repo root: sh tests/scrumux-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
SANDBOX=$(mktemp -d) || { echo "scrumux-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT
export GOV_ROOT="$SANDBOX"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }


# expect_out <expected> <desc> <cmd...> — command succeeds, and its FIRST
# LINE is exactly <expected>.
#
# It used to require the whole of stdout to equal <expected>. That is the
# wrong contract now that commands close by restating what state the work
# is in (CLAUDE.MD, "How the machine talks to the agent"): the drumbeat
# lines are guidance for a stochastic reader and they will change as the
# guidance improves. Pinning them here would calcify wording and fail on
# rewrites that made the message better.
#
# The contract that IS pinned, and that a machine consumer can rely on:
# the first line is the answer — the id, the transition, the verdict.
# Everything after it is indented and advisory. Anything parsing this
# reads line one.
expect_out() {
  exp=$1; desc=$2; shift 2
  # STDOUT only. It used to merge stderr, which was always loose and
  # became wrong once commands started reporting progress: "re-running
  # T-0001's verification" is chatter for a human and belongs on stderr,
  # where it cannot displace the answer a parser reads. Failures are
  # asserted by expect_fail, which reads stderr on purpose.
  out=$("$@" 2>/dev/null); rc=$?
  # UNINDENTED lines are the answer; indented lines are the drumbeat.
  # "first line" was too simple — an accept that completes a sprint
  # answers with two unindented lines (the task, then the cascade), and
  # both are machine-readable.
  answer=$(printf '%s\n' "$out" | grep -v '^  ' | sed '/^$/d')
  if [ $rc -eq 0 ] && [ "$answer" = "$exp" ]; then ok; else bad "$desc — want answer '$exp' rc=0, got '$answer' rc=$rc (full: '$out')"; fi
}

# The drumbeat is advisory, but "the first line is the answer" is a
# contract, so it gets an assertion of its own rather than being an
# accident of the helper above.
expect_first_line_is_the_answer() { # <desc> <expected-first-line> <cmd...>
  _d=$1; _e=$2; shift 2
  _o=$("$@" 2>&1)
  [ "$(printf '%s' "$_o" | grep -v '^  ' | sed '/^$/d' | head -1)" = "$_e" ] \
    && ok || bad "$_d — the machine-readable answer must be unindented, got: $(printf '%s' "$_o" | head -1)"
  printf '%s' "$_o" | tail -n +2 | grep -qE '^$|^  ' \
    && ok || bad "$_d — advisory lines after the answer must be indented, so a parser can tell them apart"
}
# expect_fail <stderr-substring> <desc> <cmd...> — command fails mentioning substring
expect_fail() {
  sub=$1; desc=$2; shift 2
  out=$("$@" 2>&1); rc=$?
  if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qF -- "$sub"; then ok; else bad "$desc — want failure mentioning '$sub', got rc=$rc: '$out'"; fi
}

# --- design records ---------------------------------------------------
expect_out F-0001 "feature create" "$GOVCMD" feature new --name Feat --desc Desc
expect_fail "--desc is required" "feature missing desc guard" "$GOVCMD" feature new --name X
expect_out S-0001 "story create" "$GOVCMD" story new --feature F-0001 --narrative N --criterion C
expect_fail "at least one --criterion" "story criterion guard" "$GOVCMD" story new --feature F-0001 --narrative N
expect_fail "feature F-9999 not found" "story dangling feature guard" "$GOVCMD" story new --feature F-9999 --narrative N --criterion C
expect_out E-0001 "epic create" "$GOVCMD" epic new --name Ep --desc D --feature F-0001
expect_fail "feature F-9999 not found" "epic dangling feature guard" "$GOVCMD" epic new --name E2 --desc D --feature F-9999

# --- epic update (T-0027) --------------------------------------------
expect_fail "not found" "epic update unknown id guard" "$GOVCMD" epic update E-9999 --add-feature F-0001
expect_fail "nothing to update" "epic update no-flags guard" "$GOVCMD" epic update E-0001
expect_fail "unknown flag" "epic update unknown flag guard" "$GOVCMD" epic update E-0001 --name X
expect_fail "feature F-9999 not found" "epic update dangling add guard" "$GOVCMD" epic update E-0001 --add-feature F-9999
expect_fail "already on E-0001" "epic update duplicate add guard" "$GOVCMD" epic update E-0001 --add-feature F-0001
expect_out F-0002 "second feature" "$GOVCMD" feature new --name Feat2 --desc Desc2
expect_fail "not on E-0001" "epic update absent remove guard" "$GOVCMD" epic update E-0001 --remove-feature F-0002
expect_out "E-0001 updated" "epic update add writes" "$GOVCMD" epic update E-0001 --add-feature F-0002
EFEATS=$(jq -rc '.entries[] | select(.kind=="epic" and .id=="E-0001") | .features' "$SANDBOX/governance/design.json")
[ "$EFEATS" = '["F-0001","F-0002"]' ] && ok || bad "epic update add persisted — got '$EFEATS'"
expect_out "E-0001 updated" "epic update remove writes" "$GOVCMD" epic update E-0001 --remove-feature F-0002
EFEATS=$(jq -rc '.entries[] | select(.kind=="epic" and .id=="E-0001") | .features' "$SANDBOX/governance/design.json")
[ "$EFEATS" = '["F-0001"]' ] && ok || bad "epic update remove persisted — got '$EFEATS'"

# B-statement ids allocated globally across controls; `scrumux control` wrote
# them and is gone with `scrumux surface`.

# --- tasks + lifecycle gates -----------------------------------------
expect_out T-0001 "task create" "$GOVCMD" task new --title T1 --check AC1 --feature F-0001 --story S-0001
expect_fail "--check is required" "task acceptance-check guard" "$GOVCMD" task new --title X
expect_out "T-0001 -> in_progress" "status transition" "$GOVCMD" task status T-0001 in_progress
expect_out T-0002 "second task" "$GOVCMD" task new --title T2 --check AC2 --feature F-0001 --story S-0001
expect_fail "one task at a time" "one-in-progress gate" "$GOVCMD" task status T-0002 in_progress
expect_fail "invalid status" "status enum guard" "$GOVCMD" task status T-0001 bogus
expect_fail "has no recorded acceptance" "hand transition to accepted needs the ruling on record" "$GOVCMD" task status T-0001 accepted

# --- task update (T-0023) --------------------------------------------
expect_fail "not found" "update unknown task guard" "$GOVCMD" task update T-9999 --title X
expect_fail "nothing to update" "update no-flags guard" "$GOVCMD" task update T-0002
expect_fail "feature F-9999 not found" "update dangling feature guard" "$GOVCMD" task update T-0002 --feature F-9999
expect_fail "story S-9999 not found" "update dangling story guard" "$GOVCMD" task update T-0002 --story S-9999
expect_fail "unknown flag" "update unknown flag guard" "$GOVCMD" task update T-0002 --check X
expect_out "T-0002 updated" "task update writes" "$GOVCMD" task update T-0002 --feature F-0001 --story S-0001 --title "T2 renamed"
UPD=$(jq -r '.entries[] | select(.id=="T-0002") | "\(.feature) \(.story) \(.title)"' "$SANDBOX/governance/tasks.json")
[ "$UPD" = "F-0001 S-0001 T2 renamed" ] && ok || bad "task update persisted fields — got '$UPD'"

# --- log / issue / decide --------------------------------------------
expect_out L-0001 "log create" "$GOVCMD" log new --task T-0001 --title L --did D --verified V
expect_fail "--did is required" "log did guard" "$GOVCMD" log new --title X
expect_fail "task T-9999 not found" "log dangling task guard" "$GOVCMD" log new --task T-9999 --title X --did Y
expect_out I-0001 "issue create" "$GOVCMD" issue new --type defect --source claude --summary S --fix F
expect_fail "resolution_pointer" "issue fix guard" "$GOVCMD" issue new --type defect --source claude --summary S
expect_fail "drift|defect|idea|governance|harness" "issue type enum guard" "$GOVCMD" issue new --type bogus --source claude --summary S --fix F

# --- issue update (T-0025) -------------------------------------------
expect_fail "not found" "issue update unknown id guard" "$GOVCMD" issue update I-9999 --status resolved
expect_fail "nothing to update" "issue update no-flags guard" "$GOVCMD" issue update I-0001
expect_fail "open|accepted|resolved|rejected" "issue update status enum guard" "$GOVCMD" issue update I-0001 --status bogus
expect_fail "low|medium|high|critical" "issue update severity enum guard" "$GOVCMD" issue update I-0001 --severity bogus
expect_fail "unknown flag" "issue update unknown flag guard" "$GOVCMD" issue update I-0001 --summary X
expect_out I-0002 "issue for update test" "$GOVCMD" issue new --type defect --source claude --summary S2 --fix F2 --severity low
expect_out "I-0002 updated" "issue update writes" "$GOVCMD" issue update I-0002 --status resolved --severity high
IUPD=$(jq -r '.entries[] | select(.id=="I-0002") | "\(.status) \(.severity)"' "$SANDBOX/governance/issues.json")
[ "$IUPD" = "resolved high" ] && ok || bad "issue update persisted fields — got '$IUPD'"

# --- issue authorize + duplicate + task attach (T-0040) ---------------
expect_fail "not found" "authorize unknown issue guard" "$GOVCMD" issue authorize I-9999 --by User
expect_fail "--by is required" "authorize by guard" "$GOVCMD" issue authorize I-0001
expect_fail "unknown flag" "authorize unknown flag guard" "$GOVCMD" issue authorize I-0001 --verdict reproduced
expect_out "I-0001 authorized by User" "authorize writes" "$GOVCMD" issue authorize I-0001 --by User --note "session directive"
AUTH=$(jq -r '.entries[] | select(.id=="I-0001") | "\(.authorization.by) \(.validation // "novalidation")"' "$SANDBOX/governance/issues.json")
[ "$AUTH" = "User novalidation" ] && ok || bad "authorization is its own fact, validation untouched (I-0010) — got '$AUTH'"
expect_fail "reproduced|evidenced|invalidated|duplicate" "records-check verdict enum incl duplicate" "$GOVCMD" issue validate I-0001 --verdict bogus --evidence E
expect_fail "needs --duplicate-of" "duplicate requires original" "$GOVCMD" issue validate I-0002 --verdict duplicate --evidence E
expect_fail "only goes with" "duplicate-of only with duplicate verdict" "$GOVCMD" issue validate I-0002 --verdict evidenced --evidence E --duplicate-of I-0001
expect_fail "cannot duplicate itself" "self-duplicate guard" "$GOVCMD" issue validate I-0002 --verdict duplicate --evidence E --duplicate-of I-0002
expect_fail "not found" "duplicate-of dangling ref guard" "$GOVCMD" issue validate I-0002 --verdict duplicate --evidence E --duplicate-of T-9999
expect_out "I-0002 validated: duplicate" "duplicate verdict writes" "$GOVCMD" issue validate I-0002 --verdict duplicate --evidence "same root cause" --duplicate-of T-0002
DUPOF=$(jq -r '.entries[] | select(.id=="I-0002") | .validation.duplicate_of' "$SANDBOX/governance/issues.json")
[ "$DUPOF" = "T-0002" ] && ok || bad "duplicate_of persisted — got '$DUPOF'"
expect_fail "not found" "update task-attach dangling guard" "$GOVCMD" issue update I-0002 --task T-9999
expect_out "I-0002 updated" "update task attach writes" "$GOVCMD" issue update I-0002 --task T-0002
ATT=$(jq -r '.entries[] | select(.id=="I-0002") | .refs.task' "$SANDBOX/governance/issues.json")
[ "$ATT" = "T-0002" ] && ok || bad "task attach persisted — got '$ATT'"
expect_out D-0001 "decision create" "$GOVCMD" decide new --title T --decision D --rationale R --by W
# R-024/D-S039: `decide new` without --authority records PROPOSED rather than
# refusing, and a proposed decision delegates nothing. The create above keeps
# that path under test; this ratify is what makes standing:D-0001 bind.
expect_out "D-0001 ratified by W (authority direct)." "decision ratify (R-024)" "$GOVCMD" decide ratify D-0001 --by W --authority direct
expect_fail "--by is required" "decision ratifier guard" "$GOVCMD" decide new --title T --decision D --rationale R

# `gov review`, `scrumux surface` and `scrumux control` are gone: zero callers in
# any script, hook, skill or rule, and the panel D-0076 deleted was the
# only thing that ever read an R- record. `scrumux reject` STAYS — it looked
# like an orphan by the same measure, but so does `scrumux accept`: both are
# User-facing authority, run by hand, and removing it would leave him
# able to accept work and unable to record a refusal.

# --- acceptance targets the TASK (D-0076 / T-0187) --------------------
expect_fail "not found in governance/tasks.json" "accept unknown task guard" "$GOVCMD" task accept T-9999 --by User --authority direct
expect_fail "--authority is required" "accept demands a recorded authority" "$GOVCMD" task accept T-0001 --by User
expect_fail "must be direct, app:<session>, or standing" "accept authority enum guard" "$GOVCMD" task accept T-0001 --by User --authority hearsay
expect_fail "does not resolve" "standing delegation must name a real decision" "$GOVCMD" task accept T-0001 --by User --authority standing:D-9999
expect_fail "no task-verify receipt" "accept refuses a task that was never verified" "$GOVCMD" task accept T-0001 --by User --authority direct
expect_fail "no recorded acceptance" "a hand transition to accepted needs the ruling on record" "$GOVCMD" task status T-0001 accepted

# --- task-verify writes the receipt acceptance reads (T-0187) ---------
# Both receipts come from a real task-verify run, not a fixture: the
# point of the gate is that the SCRIPT decides (D-0072 boundary 5), so a
# hand-written receipt would test the wrong half. The sandbox has no
# repo-health.json, so the order's own command is the whole verdict — and
# it counts as a check, because "the receipt actually ran something" asks
# whether anything was proved, and a deployed repo seeds no fleet.
"$GOVCMD" task order T-0001 --scope S --verify false --out O --file "a.py | why" >/dev/null 2>&1
"$ROOT/.deploy-claude/scripts/scrumux" task verify T-0001 >/dev/null 2>&1
RCPT=$(jq -c '.entries[] | select(.id=="T-0001") | .receipt' "$SANDBOX/governance/tasks.json")
printf '%s' "$RCPT" | jq -e '.rc == 1 and .checks_run == 1 and .checks_failed == 1 and .command == "false" and (.date | test("^[0-9]{4}-")) and (.at_epoch | type == "number")' >/dev/null 2>&1 \
  && ok || bad "a failing verification must leave a RED receipt on the task — got '$RCPT'"
expect_fail "receipt is RED" "accept refuses a red receipt" "$GOVCMD" task accept T-0001 --by User --authority direct
"$GOVCMD" task order T-0001 --scope S --verify true --out O --file "a.py | why" >/dev/null 2>&1
"$ROOT/.deploy-claude/scripts/scrumux" task verify T-0001 >/dev/null 2>&1
jq -e '.entries[] | select(.id=="T-0001") | .receipt.rc == 0 and .receipt.command == "true"' "$SANDBOX/governance/tasks.json" >/dev/null 2>&1 \
  && ok || bad "the last receipt wins — a passing re-run must overwrite the red one: $(jq -c '.entries[]|select(.id=="T-0001")|.receipt' "$SANDBOX/governance/tasks.json")"

expect_out "T-0001 accepted" "green receipt accepts the task (no sprint, no cascade)" "$GOVCMD" task accept T-0001 --by User --authority direct
ACC=$(jq -r '.entries[] | select(.id=="T-0001") | "\(.status) \(.acceptance.accepted) \(.acceptance.by) \(.acceptance.authority)"' "$SANDBOX/governance/tasks.json")
[ "$ACC" = "accepted true User direct" ] && ok || bad "acceptance persists on the task with its authority — got '$ACC'"
expect_out "T-0001 -> accepted" "hand transition idempotent once the ruling is on record" "$GOVCMD" task status T-0001 accepted

# --- reject (T-0028 shape, T-0187 target) -----------------------------
expect_fail "not found in governance/tasks.json" "reject unknown task guard" "$GOVCMD" task reject T-9999 --by tester --reason X
expect_fail "already accepted" "reject cannot overwrite an acceptance" "$GOVCMD" task reject T-0001 --by tester --reason "second thoughts"
expect_fail "--reason TEXT is required" "reject demands a reason" "$GOVCMD" task reject T-0002 --by tester
expect_out "T-0002 -> in_review" "stage reject target" "$GOVCMD" task status T-0002 in_review
expect_out "T-0002 rejected -> in_progress" "rejection returns the task to in_progress" "$GOVCMD" task reject T-0002 --by tester --reason "blast radius unaddressed"
REJ=$(jq -r '.entries[] | select(.id=="T-0002") | "\(.status) \(.acceptance.accepted) \(.acceptance.by) \(.acceptance.reason)"' "$SANDBOX/governance/tasks.json")
[ "$REJ" = "in_progress false tester blast radius unaddressed" ] && ok || bad "rejection persisted on the task — got '$REJ'"
# a rejected task is NOT write-once-locked: accepted:false must stay
# acceptable after the rework, which is why the guard tests == true and
# never `.acceptance // true` (lib.sh jq style 2 — // swallows false)
REJACC=$("$GOVCMD" task accept T-0002 --by User --authority direct 2>&1)
printf '%s' "$REJACC" | grep -q 'already accepted' \
  && bad "a rejected task carries accepted:false and must stay acceptable after rework — got: $REJACC" || ok
expect_out "T-0002 -> in_review" "restore fixture status" "$GOVCMD" task status T-0002 in_review

# --- task orders ------------------------------------------------------
expect_fail "--verify is required" "order verify guard" "$GOVCMD" task order T-0002 --scope S
expect_fail "at least one --file" "order files guard" "$GOVCMD" task order T-0002 --scope S --verify V
expect_fail "needs a why" "order file-why guard" "$GOVCMD" task order T-0002 --scope S --verify V --file onlypath
expect_out "T-0002 order set" "order create" "$GOVCMD" task order T-0002 --scope S --verify true --out O --file "a.py | why"

# --- sprints ----------------------------------------------------------
# T-0186: the decision queue left the CLI's agent path entirely — it is
# app/User surface now (D-0072 boundary 7). `scrumux sprint new` no longer
# shells out to a queue, no longer emits a TELL, and no longer records a
# gates row for it: it creates the sprint and prints the id. The queue is
# DIRTY here (I-0001 was authorized above and has no task home), which is
# exactly the state that used to produce the tell — so a silent, clean
# creation is the proof the dependency is gone.
# Run against a throwaway copy so the id sequences the cases below pin
# stay exactly where they were.
DQ="$SANDBOX.dq"; rm -rf "$DQ"; cp -R "$SANDBOX" "$DQ"
DQOUT=$(GOV_ROOT="$DQ" "$GOVCMD" sprint new --epic E-0001 2>&1); DQRC=$?
[ "$DQRC" -eq 0 ] && ok || bad "epic lane must create the sprint on a dirty queue — rc=$DQRC: $DQOUT"
[ "$DQOUT" = "SP-0001" ] && ok || bad "sprint new prints the sprint id and nothing else (T-0186) — got: $DQOUT"
printf '%s' "$DQOUT" | grep -qi 'decision queue' \
  && bad "the decision-queue TELL is back in sprint new — it is app surface (T-0186): $DQOUT" || ok
DQG=$(jq -r '[.entries[] | select(.gate=="decision queue non-empty at sprint new")] | length' "$DQ/governance/gates.json" 2>/dev/null || echo 0)
[ "${DQG:-0}" = "0" ] && ok || bad "sprint new must record no decision-queue gate row — got '$DQG'"
rm -rf "$DQ"
expect_out "I-0001 updated" "issue finds a task home (clears the planning queue)" "$GOVCMD" issue update I-0001 --task T-0002
expect_fail "--epic E-0001 is required" "sprint epic guard" "$GOVCMD" sprint new
expect_fail "need --issue" "hotfix issue guard" "$GOVCMD" sprint new --hotfix
expect_out SP-0001 "sprint create" "$GOVCMD" sprint new --epic E-0001
expect_out T-0003 "storyless task" "$GOVCMD" task new --title T3 --check AC3
expect_fail "task order first" "sprint order gate" "$GOVCMD" sprint add SP-0001 T-0003
expect_out "T-0002 added to SP-0001" "sprint add" "$GOVCMD" sprint add SP-0001 T-0002
# hotfix promotion requires validation OR authorization (T-0034, T-0040)
expect_out I-0003 "issue for gate tests" "$GOVCMD" issue new --type defect --source claude --summary S3 --fix F3
expect_fail "neither validation nor authorization" "hotfix ungated issue refused" "$GOVCMD" sprint new --hotfix --issue I-0003
expect_out "I-0003 validated: reproduced" "issue validate" "$GOVCMD" issue validate I-0003 --verdict reproduced --evidence "seen in test" --repro-cmd "true"
expect_fail "has no tasks" "ratify empty guard" sh -c "'$GOVCMD' sprint new --hotfix --issue I-0003 >/dev/null && '$GOVCMD' sprint ratify SP-0002 --by tester --authority direct"
expect_out SP-0003 "hotfix passes on authorization alone" "$GOVCMD" sprint new --hotfix --issue I-0001
expect_fail "duplicate of T-0002" "hotfix refuses duplicate, names original" "$GOVCMD" sprint new --hotfix --issue I-0002
# --- delegated control: the record must name who acted ------------------
#
# `--by` DEFAULTED TO THE LITERAL 'User' on ratify, accept, reject and
# repair. Nothing in this CLI verifies the caller -- `--by anyone` exits 0 --
# so the default bought no safety and wrote his name onto acts an agent took,
# silently, with `records check` never reading the field.
#
# The three tests below are the contract now: name the actor, name the basis,
# and let the app be a basis of its own.
expect_fail "--by is required" "ratify names its actor" "$GOVCMD" sprint ratify SP-0001 --authority direct
expect_fail "--by is required" "accept names its actor" "$GOVCMD" task accept T-0001 --authority direct
expect_fail "--by is required" "reject names its actor" "$GOVCMD" task reject T-0002 --reason X

expect_out "SP-0001 ratified" "sprint ratify" "$GOVCMD" sprint ratify SP-0001 --by tester --authority direct
# The ratification now carries its authority, as acceptance always has.
RATBY=$(jq -r '.entries[] | select(.id=="SP-0001") | .ratified.by' "$SANDBOX/governance/sprints.json")
[ "$RATBY" = tester ] && ok || bad "ratified.by must be the actor who ratified, got '$RATBY'"
RATAUTH=$(jq -r '.entries[] | select(.id=="SP-0001") | .ratified.authority' "$SANDBOX/governance/sprints.json")
[ "$RATAUTH" = direct ] && ok || bad "ratified.authority must be recorded, got '$RATAUTH'"
expect_out "SP-0001 -> complete" "sprint complete" "$GOVCMD" sprint status SP-0001 complete

# hotfix lane accepts a storyless task once it has an order
"$GOVCMD" task order T-0003 --scope S --verify true --out O --file "b.py | why" >/dev/null 2>&1
expect_out "T-0003 added to SP-0002" "hotfix storyless add" "$GOVCMD" sprint add SP-0002 T-0003

# T-0144: this refusal became a TELL — pure sequencing, and the
# rejection is a recorded ruling that withholding helps nobody.
# reject records the ruling and names the busy task rather than withholding it
expect_out "T-0003 -> in_progress" "busy fixture" "$GOVCMD" task status T-0003 in_progress
# expect_out is an EXACT match; this needs a substring, because the TELL
# names the busy task and then the rejection proceeds and prints its own
# line. Both facts matter: the warning survived, and the ruling landed.
_rj=$("$GOVCMD" task reject T-0002 --by tester --reason "busy-lane check" 2>&1); _rjrc=$?
if [ $_rjrc -eq 0 ] && printf '%s' "$_rj" | grep -q 'TELL: rejected work resumes immediately'; then ok
else bad "reject busy guard must TELL and still record the rejection — rc=$_rjrc: $_rj"; fi
printf '%s' "$_rj" | grep -q 'T-0002 rejected -> in_progress' \
  && ok || bad "the ruling must land after the TELL — got: $_rj"
expect_out "T-0003 -> proposed" "busy fixture restore" "$GOVCMD" task status T-0003 proposed

# --- rank (T-0035) ----------------------------------------------------
expect_out T-0004 "task for rank test" "$GOVCMD" task new --title T4 --check AC4
expect_fail "must be a positive integer" "rank pos guard" "$GOVCMD" rank set T-0002 x
expect_fail "out of range" "rank range guard" "$GOVCMD" rank set 9 1
expect_fail "not an open task" "rank accepted-task guard" "$GOVCMD" rank set T-0001 1
expect_fail "list # or a task id" "rank ref guard" "$GOVCMD" rank set bogus 1
# I-0044/T-0096: ranking promotes ONE task into the ranked list. It no
# longer densifies across every open task — doing so stamped priorities
# onto work nobody had ranked. Ranked ids report their rank; everything
# else stays unranked and is addressable only by id.
ranks_of() { jq -r '[.entries[] | select(.status != "accepted" and .rank != null)] | sort_by(.rank) | map("\(.id)=\(.rank)") | join(" ")' "$SANDBOX/governance/tasks.json"; }
unranked_count() { jq -r '[.entries[] | select(.status != "accepted" and .rank == null)] | length' "$SANDBOX/governance/tasks.json"; }
expect_out "T-0004 -> rank 1" "rank by id" "$GOVCMD" rank set T-0004 1
RANKS=$(ranks_of)
[ "$RANKS" = "T-0004=1" ] && ok || bad "ranking one task must rank only that task — got '$RANKS'"
[ "$(unranked_count)" = 2 ] && ok || bad "unranked work must stay unranked — got $(unranked_count) unranked, want 2"
# the numeric address space addresses the RANKED list, which holds one item
expect_fail "out of range" "positional ref covers ranked list only" "$GOVCMD" rank set 2 1
expect_out "T-0002 -> rank 2" "promote an unranked task by id" "$GOVCMD" rank set T-0002 2
RANKS=$(ranks_of)
[ "$RANKS" = "T-0004=1 T-0002=2" ] && ok || bad "promotion appends to the ranked list — got '$RANKS'"
expect_out "T-0002 -> rank 1" "reorder within the ranked list" "$GOVCMD" rank set 2 1
RANKS=$(ranks_of)
[ "$RANKS" = "T-0002=1 T-0004=2" ] && ok || bad "dense ranks after positional move — got '$RANKS'"
[ "$(unranked_count)" = 1 ] && ok || bad "reordering must not touch unranked work — got $(unranked_count) unranked, want 1"
# T-0187: scrumux writes no longer render the views, so a view assertion
# names the regeneration it depends on instead of relying on the last
# write having done it as a side effect.
"$GOVCMD" views render >/dev/null 2>&1
L4=$(grep -n '\*\*T-0004' "$SANDBOX/BACKLOG.MD" | cut -d: -f1); L3=$(grep -n '\*\*T-0003' "$SANDBOX/BACKLOG.MD" | cut -d: -f1)
[ -n "$L4" ] && [ -n "$L3" ] && [ "$L4" -lt "$L3" ] && ok || bad "BACKLOG.MD orders by rank within status — T-0004@$L4 T-0003@$L3"

# --- task-lint prints the ratified check (I-0007) --------------------
LINT_OUT=$("$ROOT/.deploy-claude/scripts/scrumux" task lint T-0002 2>&1 || true)
printf '%s\n' "$LINT_OUT" | grep -q '  check: AC2' && ok || bad "task-lint prints acceptance_check under the header — got: $(printf '%s' "$LINT_OUT" | head -3)"

# --- accept cascade (T-0054, re-pointed at the task by T-0187) --------
# The no-silent-finishes guard stood here and refused acceptance until a
# scrumux log entry existed. It left with the same check in the close: the
# finished task and its script-written receipt ARE the record. Keeping it
# on one side only made the two disagree — the agent closed clean and
# User hit a wall. What acceptance still refuses is a task with no
# receipt at all, which is the boundary-5 gate and the one that matters.
expect_fail "has no task-verify receipt" "accept refuses work that was never verified" "$GOVCMD" task accept T-0004 --by tester --authority direct
expect_out "SP-0002 ratified" "ratify hotfix sprint for cascade" "$GOVCMD" sprint ratify SP-0002 --by tester --authority app:test-session
"$GOVCMD" log new --task T-0003 --title L3 --did D3 --verified V3 >/dev/null 2>&1
"$ROOT/.deploy-claude/scripts/scrumux" task verify T-0003 >/dev/null 2>&1
jq -e '.entries[] | select(.id=="T-0003") | .receipt.rc == 0' "$SANDBOX/governance/tasks.json" >/dev/null 2>&1 \
  && ok || bad "cascade fixture needs a green receipt on T-0003"
# a ratified sprint completes when its last task is accepted — the one
# behaviour that had to survive the move from the review to the task
CASCADE2=$(printf 'T-0003 accepted\nSP-0002 -> complete')
expect_out "$CASCADE2" "accept cascades to sprint completion" "$GOVCMD" task accept T-0003 --by tester --authority standing:D-0001
SPST=$(jq -r '.entries[] | select(.id=="SP-0002") | .status' "$SANDBOX/governance/sprints.json")
[ "$SPST" = complete ] && ok || bad "the sprint must be complete once every task is accepted — got '$SPST'"
STAND=$(jq -r '.entries[] | select(.id=="T-0003") | .acceptance.authority' "$SANDBOX/governance/tasks.json")
[ "$STAND" = "standing:D-0001" ] && ok || bad "a standing delegation must be recorded verbatim — got '$STAND'"

# --- superseded decisions never surface (T-0039) ---------------------
expect_out D-0002 "superseding decision" "$GOVCMD" decide new --title T2 --decision D2 --rationale R2 --by W --supersedes D-0001
# R-024: supersession follows standing. A PROPOSED successor stamps nothing;
# ratifying it is what back-stamps superseded_by onto D-0001.
expect_out "D-0002 ratified by W (authority direct)." "ratify the successor (R-024)" "$GOVCMD" decide ratify D-0002 --by W --authority direct
# T-0187: the decide above no longer renders DECISIONS.MD as a side
# effect — a view assertion asks for the view.
"$GOVCMD" views render >/dev/null 2>&1
grep -q 'Superseded (archive' "$SANDBOX/DECISIONS.MD" && ok || bad "DECISIONS.MD archive marker missing"
awk '/Superseded \(archive/{f=1} f' "$SANDBOX/DECISIONS.MD" | grep -q '## D-0001' && ok || bad "D-0001 should render under the archive"
awk '/Superseded \(archive/{exit} {print}' "$SANDBOX/DECISIONS.MD" | grep -q '## D-0001' && bad "superseded D-0001 leaked into the live section" || ok
BRIEF_D=$("$ROOT/.deploy-claude/scripts/scrumux" status session 2>/dev/null)
printf '%s\n' "$BRIEF_D" | sed -n '/recent decisions:/,+2p' | grep -q 'D-0001' && bad "superseded D-0001 in the scrumux status session tail" || ok
printf '%s\n' "$BRIEF_D" | sed -n '/recent decisions:/,+2p' | grep -q 'D-0002' && ok || bad "live D-0002 must still render in the tail (absence-only tests hide breakage)"
"$GOVCMD" task order T-0004 --scope S --verify true --out O --file "z | why" --ref D-0001 >/dev/null 2>&1
TB_D=$("$ROOT/.deploy-claude/scripts/scrumux" task brief T-0004 2>&1 || true)
printf '%s\n' "$TB_D" | grep -q 'SUPERSEDED by D-0002' && ok || bad "task-brief D-ref lacks superseded marker — got: $(printf '%s' "$TB_D" | grep 'D-0001' || echo 'no D-0001 line')"

# --- views ------------------------------------------------------------
expect_out "views regenerated" "views command" "$GOVCMD" views render
for v in AI_LOG.MD DECISIONS.MD BACKLOG.MD; do
  [ -s "$SANDBOX/$v" ] && ok || bad "view $v missing or empty after regeneration"
done
grep -q 'GENERATED VIEW' "$SANDBOX/BACKLOG.MD" && ok || bad "BACKLOG.MD missing generated-view banner"

# --- journals stay valid JSON ----------------------------------------
for f in "$SANDBOX"/governance/*.json; do
  jq -e . "$f" >/dev/null 2>&1 && ok || bad "journal $f is not valid JSON"
done

# --- T-0116/I-0060/D-0041: an order states HOW to run its suite -------
# Four orders pointed at tests/*.sh with no interpreter and ran only
# because those suites happen to be mode 755, while 27 of the 38 files in
# tests/ are mode 644 and exit 126 invoked bare. The rule is a STRING
# rule and never stats the target: making it mode-aware would bless the
# very dependency it exists to remove.
"$GOVCMD" task order T-0002 --story S-0001 --scope "bare suite path" \
  --verify "tests/scrumux-tests.sh" --out "nothing" \
  --file "README.MD | why" >/dev/null 2>&1
OUT=$("$ROOT/.deploy-claude/scripts/scrumux" task lint T-0002 2>&1 || true)
printf '%s' "$OUT" | grep -q 'without an interpreter' \
  && ok || bad "a bare tests/*.sh verify path must fail lint: $(printf '%s' "$OUT" | grep FAIL | head -1)"
printf '%s' "$OUT" | grep -q "sh tests/scrumux-tests.sh" \
  && ok || bad "the refusal must name the corrected command"

# it must fail EVEN THOUGH the target is executable — that is the point,
# and it is why the four normalised orders needed fixing at all. Use a
# suite that really is mode 755 (11 of 38 are; scrumux-tests itself is 644,
# so asserting against it would have proved nothing).
EXEC_SUITE=tests/session-check-tests.sh
[ -x "$ROOT/$EXEC_SUITE" ] || bad "fixture assumption broken: $EXEC_SUITE is not executable"
"$GOVCMD" task order T-0002 --story S-0001 --scope "bare path at an EXECUTABLE suite" \
  --verify "$EXEC_SUITE" --out "nothing" --file "README.MD | why" >/dev/null 2>&1
OUT=$("$ROOT/.deploy-claude/scripts/scrumux" task lint T-0002 2>&1 || true)
printf '%s' "$OUT" | grep -q 'without an interpreter' \
  && ok || bad "the rule must not exempt an executable target (D-0041): $OUT"

# and the interpreted form passes
"$GOVCMD" task order T-0002 --story S-0001 --scope "interpreted suite path" \
  --verify "sh tests/scrumux-tests.sh" --out "nothing" \
  --file "README.MD | why" >/dev/null 2>&1
OUT=$("$ROOT/.deploy-claude/scripts/scrumux" task lint T-0002 2>&1 || true)
printf '%s' "$OUT" | grep -q 'without an interpreter' \
  && bad "the interpreted form must lint clean: $OUT" || ok

# a non-suite command is untouched by the rule
"$GOVCMD" task order T-0002 --story S-0001 --scope "a script, not a suite" \
  --verify ".claude/scripts/scrumux" records check --out "nothing" \
  --file "README.MD | why" >/dev/null 2>&1
OUT=$("$ROOT/.deploy-claude/scripts/scrumux" task lint T-0002 2>&1 || true)
printf '%s' "$OUT" | grep -q 'without an interpreter' \
  && bad "the rule must only govern tests/ suite paths: $OUT" || ok

# --- T-0189/D-0073: the light lane ------------------------------------
# The CLI has to work standalone, which means a session with no app
# behind it must be able to turn User's message into a task. `--light`
# marks the order; three consumers read the mark and NOTHING else in the
# plain lane may move. The negative assertions are the load-bearing ones:
# a plain order carries no light key at all, a plain storyless task is
# still refused, and boundary 4 still FAILs in the light lane. A "light"
# lane that also relaxed the acceptance check would not be lighter, it
# would be unfinishable.
#
# Runs against a throwaway COPY so the id sequences the cases above pin
# stay exactly where they were (same reason as the DQ block).
LT="$SANDBOX.light"; rm -rf "$LT"; cp -R "$SANDBOX" "$LT"
LTG() { GOV_ROOT="$LT" "$GOVCMD" "$@"; }
LTLINT() { GOV_ROOT="$LT" "$ROOT/.deploy-claude/scripts/scrumux" task lint "$@"; }

TPLAIN=$(LTG task new --title "plain storyless" --check "AC plain" 2>/dev/null)
TLIGHT=$(LTG task new --title "light storyless" --check "AC light" 2>/dev/null)
{ [ -n "$TPLAIN" ] && [ -n "$TLIGHT" ]; } \
  && ok || bad "light-lane fixtures were not created — got '$TPLAIN' '$TLIGHT'"

LTG task order "$TPLAIN" --scope "plain" --verify true --out O --file "p.py | why" >/dev/null 2>&1
LTG task order "$TLIGHT" --light --scope "from User's message" --verify true --out O --file "l.py | why" >/dev/null 2>&1

# 1. the mark is written, and ONLY when asked for
jq -e --arg t "$TLIGHT" '.entries[] | select(.id==$t) | .task_order.light == true' "$LT/governance/tasks.json" >/dev/null 2>&1 \
  && ok || bad "scrumux task order --light must write task_order.light=true — got $(jq -c --arg t "$TLIGHT" '.entries[]|select(.id==$t)|.task_order' "$LT/governance/tasks.json")"
jq -e --arg t "$TPLAIN" '.entries[] | select(.id==$t) | .task_order | has("light") | not' "$LT/governance/tasks.json" >/dev/null 2>&1 \
  && ok || bad "a plain order must carry NO light key — an absent key is what keeps every order written before T-0189 in the plain lane"

# 2. the widened schema admits it. write_json is schema-guarded, so the
# write landing IS the proof the closed order object took the new field;
# a stale schema would have refused it and left the order unchanged.
jq -e --arg t "$TLIGHT" '.entries[] | select(.id==$t) | .task_order.scope == "from User'"'"'s message"' "$LT/governance/tasks.json" >/dev/null 2>&1 \
  && ok || bad "the light order did not persist — task.schema.json's order object is additionalProperties:false and has not been widened for light"

# 3. sprint add: storyless passes light, and is still refused plain
LTSP=$(LTG sprint new --epic E-0001 2>/dev/null)
[ -n "$LTSP" ] && ok || bad "light-lane sprint fixture was not created"
OUT=$(LTG sprint add "$LTSP" "$TLIGHT" 2>&1); RC=$?
{ [ $RC -eq 0 ] && [ "$OUT" = "$TLIGHT added to $LTSP" ]; } \
  && ok || bad "an epic-lane sprint must accept a storyless LIGHT task — rc=$RC: $OUT"
OUT=$(LTG sprint add "$LTSP" "$TPLAIN" 2>&1); RC=$?
{ [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -qF 'one user story per task'; } \
  && ok || bad "the plain storyless refusal must survive the light lane — rc=$RC: $OUT"

# 4. task-lint tiers. Same finding, lower tier — never a second message.
OUT=$(LTLINT "$TLIGHT" 2>&1); RC=$?
[ $RC -eq 0 ] && ok || bad "a light order with no story must LINT CLEAN — rc=$RC: $OUT"
printf '%s' "$OUT" | grep -qE 'TELL +[A-Z]-[0-9]{4} +no story' \
  && ok || bad "the story finding must still be NAMED under light, as a TELL: $OUT"
printf '%s' "$OUT" | grep -qE 'FAIL +[A-Z]-[0-9]{4} +no story' \
  && bad "the story finding must not stay a FAIL under light: $OUT" || ok
printf '%s' "$OUT" | grep -q 'lane: light' \
  && ok || bad "task-lint must say which lane it is judging in, or a TELL where a FAIL was expected reads as a bug: $OUT"

OUT=$(LTLINT "$TPLAIN" 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "the PLAIN lane must be untouched — a storyless plain order still fails lint: $OUT"
printf '%s' "$OUT" | grep -qE 'FAIL +[A-Z]-[0-9]{4} +no story' \
  && ok || bad "the plain storyless FAIL must keep its exact wording: $OUT"
printf '%s' "$OUT" | grep -q 'lane: light' \
  && bad "the lane line must not print for a plain order — the plain lane is byte-identical: $OUT" || ok

# 5. boundary 4 does NOT move with the lane
LTG task order "$TLIGHT" --light --scope "composite verify, light lane" \
  --verify "sh tests/scrumux-tests.sh && sh tests/status-tests.sh" --out O --file "l.py | why" >/dev/null 2>&1
OUT=$(LTLINT "$TLIGHT" 2>&1); RC=$?
{ [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -qE 'FAIL +[A-Z]-[0-9]{4} +verification_command looks composite'; } \
  && ok || bad "a light order gets ONE verification command like every other — boundary 4 names light tasks explicitly — rc=$RC: $OUT"
expect_fail "--check is required" "boundary 4: no lane mints a task without an acceptance check" \
  sh -c "GOV_ROOT='$LT' '$GOVCMD' task new --title 'no check'"

# 6. --light is discoverable
LTG help task 2>&1 | grep -qF -- '--light' \
  && ok || bad "scrumux help task does not list --light, so the lane exists only for whoever already knew about it"

rm -rf "$LT"

# The suite-ownership advisory this section drove is gone with the
# coverage lens that shared its map (c6609fc). It told the agent to amend
# its own order, from a linter, before any code was written.
#
# ITS TWO TESTS OUTLIVED IT BY A MONTH, and were removed 2026-08-27.
# Both greped `task lint` output for a warning the CLI can no longer emit
# -- `exercises` appears nowhere in .claude/scripts -- so both asserted the
# ABSENCE of an impossible string and passed unconditionally. The second was
# worse still: it wrote its fixture to "$SANDBOX/tests/", a directory that
# does not exist, so the redirect failed, the bystander suite was never
# created, and the test compared nothing against nothing while printing a
# "No such file or directory" line into every run.
#
# A vacuous test is not free. These two inflated the suite's count by two
# and stood as evidence for a mechanism that had been deliberately deleted.

# --- T-0095/I-0042: acceptance is write-once --------------------------
# Re-accepting silently rewrote acceptance.date and cascaded a fresh
# updated_at onto the task — the I-0006 failure mode, since session-check
# reads updated_at as evidence of work. It cost real damage when a
# mistyped id hit R-0063 (L-0103). T-0187 moved the target; the guard is
# the same guard.
"$GOVCMD" task new --title "accept-once" --check AC --feature F-0001 --story S-0001 >/dev/null 2>&1
ONCE=$(jq -r '[.entries[]|select(.title=="accept-once")][0].id' "$SANDBOX/governance/tasks.json")
"$GOVCMD" task status "$ONCE" in_progress >/dev/null 2>&1
"$GOVCMD" log new --task "$ONCE" --title L --did D --verified V >/dev/null 2>&1
"$GOVCMD" task order "$ONCE" --scope S --verify true --out O --file "c.py | why" >/dev/null 2>&1
"$ROOT/.deploy-claude/scripts/scrumux" task verify "$ONCE" >/dev/null 2>&1
"$GOVCMD" task accept "$ONCE" --by User --authority direct >/dev/null 2>&1 \
  && ok || bad "the first acceptance must succeed"
STAMP=$(jq -r '.entries[]|select(.id=="'"$ONCE"'")|.updated_at' "$SANDBOX/governance/tasks.json")

OUT=$("$GOVCMD" task accept "$ONCE" --by User --authority direct 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "a second acceptance must be refused — rc=$RC: $OUT"
printf '%s' "$OUT" | grep -q 'already accepted by User' \
  && ok || bad "the refusal must name the prior acceptor and date: $OUT"
printf '%s' "$OUT" | grep -q 'scrumux task reject' \
  && ok || bad "the refusal must name the way to reverse it: $OUT"
AFTER=$(jq -r '.entries[]|select(.id=="'"$ONCE"'")|.updated_at' "$SANDBOX/governance/tasks.json")
[ "$STAMP" = "$AFTER" ] && ok || bad "a refused acceptance must not restamp the task ($STAMP -> $AFTER)"

# --- T-0100/I-0047: scrumux repair is a first-class path -------------------
# A correction with no other scrumux path meant a direct write plus a
# VOLUNTARY log entry — and the voluntary half is what went missing when
# the R-0063 dates were restored by hand (L-0103, written only after
# User asked). Here the write and its record are one operation.
BEFORE_LOGS=$(jq '.entries | length' "$SANDBOX/governance/log.json")
"$GOVCMD" repair journal issues.json \
  --apply '.entries |= map(if .id=="I-0001" then .severity="medium" else . end)' \
  --why "fixture repair" --by tester >/dev/null 2>&1 \
  && ok || bad "a valid repair must succeed"
AFTER_LOGS=$(jq '.entries | length' "$SANDBOX/governance/log.json")
[ "$AFTER_LOGS" -gt "$BEFORE_LOGS" ] \
  && ok || bad "a repair must write its own log entry in the same operation ($BEFORE_LOGS -> $AFTER_LOGS)"
jq -e '[.entries[] | select(.title | test("Repair applied"))] | length >= 1' "$SANDBOX/governance/log.json" >/dev/null \
  && ok || bad "the log entry must name itself a repair"
jq -e '[.entries[] | select(.what_was_done | test("fixture repair"))] | length >= 1' "$SANDBOX/governance/log.json" >/dev/null \
  && ok || bad "the recorded reason must survive into the log"

expect_fail "--why is required" "repair reason guard" "$GOVCMD" repair journal issues.json --apply '.'
expect_fail "--by is required" "repair names its actor" "$GOVCMD" repair journal issues.json --apply '.' --why W
expect_fail "no journal at" "repair unknown journal guard" "$GOVCMD" repair journal nope.json --apply '.' --why W --by tester
expect_fail "changed nothing" "repair no-op guard" "$GOVCMD" repair journal issues.json --apply '.' --why W --by tester

# --- T-0115/I-0059: a disproven task can be retired --------------------
# T-0098 sat at rank 4 for a day advertising an acceptance check for
# behaviour the issue-validator had disproved, because no terminal state
# existed. The state touches FOUR homes — scrumux's enum, governance-validate's
# duplicate of it, the schema, and the backlog's open-work filter.
"$GOVCMD" task new --title "to-retire" --check AC --feature F-0001 --story S-0001 >/dev/null 2>&1
RET=$(jq -r '[.entries[]|select(.title=="to-retire")][0].id' "$SANDBOX/governance/tasks.json")
expect_fail "needs --reason" "superseded reason guard" "$GOVCMD" task status "$RET" superseded
# R-018: a block records what it waits on, so --reason is allowed with
# blocked. Only --by is still superseded's alone.
expect_out "$RET -> blocked" "blocked records its reason (R-018)" "$GOVCMD" task status "$RET" blocked --reason X
expect_fail "belongs to superseded only" "by-only-with-superseded guard" "$GOVCMD" task status "$RET" blocked --by T-0001
expect_fail "not found" "superseded replacement must exist" "$GOVCMD" task status "$RET" superseded --reason R --by T-9999
expect_out "$RET -> superseded" "superseded with a reason" "$GOVCMD" task status "$RET" superseded --reason "premise disproven" --by T-0001
jq -e --arg i "$RET" '[.entries[]|select(.id==$i and .superseded.reason=="premise disproven" and .superseded.by=="T-0001")]|length==1' \
  "$SANDBOX/governance/tasks.json" >/dev/null && ok || bad "the reason and replacement must persist"

# governance-validate must accept the new state, not report it as invalid
OUT=$(cd "$SANDBOX" && "$ROOT/.deploy-claude/scripts/scrumux" records check 2>&1 || true)
printf '%s' "$OUT" | grep -q "invalid status superseded" \
  && bad "governance-validate carries a duplicate enum and must accept superseded: $OUT" || ok

# and the backlog must stop listing it as open work — leaving it visible
# is the misleading surface this task exists to remove
OUT=$(cd "$SANDBOX" && "$ROOT/.deploy-claude/scripts/scrumux" backlog tasks 2>&1 || true)
printf '%s' "$OUT" | grep -q "$RET" \
  && bad "a superseded task must not list as open work: $OUT" || ok

# --- T-0114/T-0104: a record's text can be corrected -------------------
# A wrong resolution pointer could only be corrected by a superseding
# DECISION, and the validator showed supersession is invisible from the
# issue — I-0055's stale pointer stayed a live promotion hazard because
# acceptance checks have been written from a pointer verbatim.
"$GOVCMD" issue new --type defect --source claude --summary "amendable" --fix "the original pointer" >/dev/null 2>&1
AMD=$(jq -r '[.entries[]|select(.summary=="amendable")][0].id' "$SANDBOX/governance/issues.json")
expect_out "$AMD updated" "issue fix amend" "$GOVCMD" issue update "$AMD" --fix "the corrected pointer"
jq -e --arg i "$AMD" '[.entries[]|select(.id==$i and .resolution_pointer=="the corrected pointer")]|length==1' \
  "$SANDBOX/governance/issues.json" >/dev/null && ok || bad "the pointer must be replaced"
jq -e --arg i "$AMD" '[.entries[]|select(.id==$i and .prior_resolution_pointers[0].text=="the original pointer")]|length==1' \
  "$SANDBOX/governance/issues.json" >/dev/null \
  && ok || bad "the prior text must be KEPT — a silent overwrite hides that a correction happened"
expect_fail "nothing to update" "issue update still needs a flag" "$GOVCMD" issue update "$AMD"

# T-0104: the same gap on a task description, which no renderer showed
# and no command could change
"$GOVCMD" task new --title "descless" --check AC --feature F-0001 --story S-0001 --desc "first" >/dev/null 2>&1
DSC=$(jq -r '[.entries[]|select(.title=="descless")][0].id' "$SANDBOX/governance/tasks.json")
expect_out "$DSC updated" "task desc amend" "$GOVCMD" task update "$DSC" --desc "second"
jq -e --arg i "$DSC" '[.entries[]|select(.id==$i and .description=="second")]|length==1' \
  "$SANDBOX/governance/tasks.json" >/dev/null && ok || bad "the description must be replaced"
jq -e '[.entries[]|select(.title=="descless" and .description=="second")]|length==1' \
  "$SANDBOX/governance/tasks.json" >/dev/null && ok || bad "task new --desc must still work — its flag shares a name"

# --- T-0113/I-0056: the OTHER lane is gated too ------------------------
# scrumux sprint new gates the HOTFIX lane on validation, but sprint-plan
# Step 1b's backlog-promotion lane had no --issue flag and no gate at
# all, so an unvalidated issue could become backlog work unopposed.
"$GOVCMD" issue new --type defect --source claude --summary "unvalidated promo" --fix F >/dev/null 2>&1
UNV=$(jq -r '[.entries[]|select(.summary=="unvalidated promo")][0].id' "$SANDBOX/governance/issues.json")
expect_fail "no validation verdict" "promotion gate: unvalidated refused" \
  "$GOVCMD" task new --title P1 --check AC --issue "$UNV"
expect_fail "not found" "promotion gate: unknown issue refused" \
  "$GOVCMD" task new --title P2 --check AC --issue I-9999
"$GOVCMD" issue validate "$UNV" --verdict evidenced --evidence E --by issue-validator >/dev/null 2>&1
"$GOVCMD" task new --title P3 --check AC --issue "$UNV" >/dev/null 2>&1 \
  && ok || bad "a validated issue must be promotable"
"$GOVCMD" issue new --type defect --source claude --summary "invalid promo" --fix F >/dev/null 2>&1
INV=$(jq -r '[.entries[]|select(.summary=="invalid promo")][0].id' "$SANDBOX/governance/issues.json")
"$GOVCMD" issue validate "$INV" --verdict invalidated --evidence E --by issue-validator >/dev/null 2>&1
expect_fail "was invalidated" "promotion gate: invalidated refused" \
  "$GOVCMD" task new --title P4 --check AC --issue "$INV"
# promotion without --issue is unchanged: not every task comes from one
"$GOVCMD" task new --title P5 --check AC >/dev/null 2>&1 \
  && ok || bad "a task with no originating issue must still be creatable"

# --- T-0119/I-0064: an order may declare what it will CREATE ----------
# Optional by necessity: context is additionalProperties:false with five
# required keys, so a sixth REQUIRED key would invalidate all 114 orders
# already written and mint a drift issue per task through the monitor.
expect_out "T-0002 order set" "order with --artifact" "$GOVCMD" task order T-0002 \
  --scope S --verify true --out O --file "a.py | why" --artifact "pkg/new_module.py"
AKEYS=$(jq -rc '.entries[] | select(.id=="T-0002") | .task_order.context.expected_artifacts' "$SANDBOX/governance/tasks.json")
[ "$AKEYS" = '["pkg/new_module.py"]' ] && ok || bad "expected_artifacts persisted — got '$AKEYS'"
expect_fail "cannot contain whitespace" "artifact whitespace guard" "$GOVCMD" task order T-0002 \
  --scope S --verify true --file "a.py | why" --artifact "has space.py"
# ...and an order written WITHOUT the flag keeps exactly the five keys
expect_out "T-0002 order set" "order without --artifact" "$GOVCMD" task order T-0002 \
  --scope S --verify true --out O --file "a.py | why"
CKEYS=$(jq -rc '.entries[] | select(.id=="T-0002") | .task_order.context | keys' "$SANDBOX/governance/tasks.json")
[ "$CKEYS" = '["commands","data_shapes","files","interfaces","refs"]' ] \
  && ok || bad "an order without --artifact must emit exactly the five keys — got '$CKEYS'"

# --- T-0067: descope removes UNWORKED work, with a reason -------------
# D-0022 was a descope recorded by hand because no path existed. Its own
# sandbox: removing a task from the shared fixture's sprint would disturb
# the assertions above.
DSBOX=$(mktemp -d) || { echo "scrumux-tests: error: cannot create descope sandbox" >&2; exit 1; }
(
  export GOV_ROOT="$DSBOX"
  "$GOVCMD" feature new --name F --desc D >/dev/null 2>&1
  "$GOVCMD" story new --feature F-0001 --narrative N --criterion C >/dev/null 2>&1
  "$GOVCMD" epic new --name E --desc D --feature F-0001 >/dev/null 2>&1
  for n in 1 2; do
    "$GOVCMD" task new --title "T$n" --check A --feature F-0001 --story S-0001 >/dev/null 2>&1
    "$GOVCMD" task order "T-000$n" --scope S --verify true --out O --file "a | b" --story S-0001 >/dev/null 2>&1
  done
  "$GOVCMD" sprint new --epic E-0001 >/dev/null 2>&1
  "$GOVCMD" sprint add SP-0001 T-0001 >/dev/null 2>&1
  "$GOVCMD" sprint add SP-0001 T-0002 >/dev/null 2>&1
  "$GOVCMD" sprint ratify SP-0001 --by tester >/dev/null 2>&1

  "$GOVCMD" sprint descope SP-0001 T-0002 >/dev/null 2>&1 && echo DS_REASON_FAIL || echo DS_REASON_PASS
  "$GOVCMD" sprint descope SP-0001 T-0002 --reason "deferred" >/dev/null 2>&1 && echo DS_OK_PASS || echo DS_OK_FAIL
  jq -e '[.entries[] | select(.id=="SP-0001")] | .[0] | ((.tasks | index("T-0002")) == null)
         and ((.descoped // []) | length) == 1
         and (.descoped[0].reason == "deferred")' "$DSBOX/governance/sprints.json" >/dev/null 2>&1 \
    && echo DS_RECORD_PASS || echo DS_RECORD_FAIL
  # T-0144: a task that was WORKED is now descoped with a TELL rather
  # than refused. The old message already named both alternatives, so it
  # knew what the caller should do and refused to do it anyway; and the
  # log entries it warns about are not erased by descoping. The TELL must
  # still appear — losing the warning would be the actual regression.
  "$GOVCMD" log new --task T-0001 --title L --did D >/dev/null 2>&1
  "$GOVCMD" sprint descope SP-0001 T-0001 --reason "changed my mind" 2>&1 \
    | grep -q 'TELL: T-0001 has 1 log entry' && echo DS_WORKED_PASS || echo DS_WORKED_FAIL
  jq -e '[.entries[] | select(.id=="SP-0001")] | .[0] | (.tasks | index("T-0001")) == null' \
    "$DSBOX/governance/sprints.json" >/dev/null 2>&1 && echo DS_KEPT_PASS || echo DS_KEPT_FAIL
  # a task the sprint does not carry
  "$GOVCMD" sprint descope SP-0001 T-0002 --reason "again" >/dev/null 2>&1 \
    && echo DS_ABSENT_FAIL || echo DS_ABSENT_PASS
) > "$DSBOX/out.txt" 2>&1
for _c in DS_REASON DS_OK DS_RECORD DS_WORKED DS_KEPT DS_ABSENT; do
  if grep -q "${_c}_PASS" "$DSBOX/out.txt"; then ok
  else bad "$_c — see $(grep "$_c" "$DSBOX/out.txt" | head -1)"; fi
done
rm -rf "$DSBOX"

# --- T-0100 follow-up: what the seal actually protects ----------------
# Two properties, both of which the original design failed. Its own
# sandbox so the tamper cannot disturb the assertions above.
SEALBOX=$(mktemp -d) || { echo "scrumux-tests: error: cannot create seal sandbox" >&2; exit 1; }
(
  export GOV_ROOT="$SEALBOX"
  "$GOVCMD" feature new --name F --desc D >/dev/null 2>&1
  "$GOVCMD" task new --title T --check A >/dev/null 2>&1
  jq '.entries[0].title = "TAMPERED"' "$SEALBOX/governance/tasks.json" > "$SEALBOX/t.json" \
    && mv "$SEALBOX/t.json" "$SEALBOX/governance/tasks.json"

  # 1. a hand edit must SURVIVE an unrelated legitimate gov write.
  # render_views used to call seal_journals on every write, rewriting
  # EVERY hash — so one `scrumux decide` against decisions.json erased a
  # tamper in tasks.json. Measured before the fix: report present, then
  # gone. write_json now reseals only the file it wrote.
  "$GOVCMD" decide new --title T --decision D --rationale R --by tester >/dev/null 2>&1
  if "$ROOT/.deploy-claude/scripts/scrumux" records check 2>&1 | grep -q 'tasks.json was changed outside scrumux'; then
    echo SEAL_SURVIVES_PASS
  else
    echo SEAL_SURVIVES_FAIL
  fi
  # ...and the journal scrumux legitimately wrote must NOT be flagged
  if "$ROOT/.deploy-claude/scripts/scrumux" records check 2>&1 | grep -q 'decisions.json was changed outside scrumux'; then
    echo SEAL_NOFALSEPOS_FAIL
  else
    echo SEAL_NOFALSEPOS_PASS
  fi

  # 2. a no-op repair must not LAUNDER a tamper. cmd_repair wrote first
  # and judged after, so `--apply .` rewrote the same bytes, resealed
  # them, and died — erasing the mismatch with no log entry.
  "$GOVCMD" repair journal tasks.json --apply '.' --why "laundering attempt" --by attacker >/dev/null 2>&1
  if "$ROOT/.deploy-claude/scripts/scrumux" records check 2>&1 | grep -q 'tasks.json was changed outside scrumux'; then
    echo SEAL_NOLAUNDER_PASS
  else
    echo SEAL_NOLAUNDER_FAIL
  fi

  # 3. a genuine repair still applies, logs and reseals
  "$GOVCMD" repair journal tasks.json --apply '(.entries[0].title) = "Restored"' \
    --why "genuine correction" --by tester >/dev/null 2>&1
  if "$ROOT/.deploy-claude/scripts/scrumux" records check 2>&1 | grep -q 'tasks.json was changed outside scrumux'; then
    echo SEAL_REPAIR_FAIL
  else
    echo SEAL_REPAIR_PASS
  fi
) > "$SEALBOX/out.txt" 2>&1
for _c in SEAL_SURVIVES SEAL_NOFALSEPOS SEAL_NOLAUNDER SEAL_REPAIR; do
  if grep -q "${_c}_PASS" "$SEALBOX/out.txt"; then ok
  else bad "$_c — see $(grep "$_c" "$SEALBOX/out.txt" | head -1)"; fi
done
rm -rf "$SEALBOX"

# --- scrumux flags vs `scrumux help` (T-0142, folded in by T-0186) -----------
# The one check script-roster-tests carried that nothing else does: a
# flag the scrumux parser accepts but `scrumux help` does not list, so the cheat
# sheet quietly stops being the interface. Checked ONE direction only —
# the parser is the truth, the prose is the thing that decays. The help
# text stays CURATED (it carries the gate rules a generated usage line
# would destroy); this assertion is what keeps it true.
# Where the flags live moved with the consolidation: the parser is now
# nineteen lib/cmd-*.sh modules and the prose is nineteen <noun>_usage
# blocks. The CHECK is unchanged in meaning — every flag the parser
# accepts must appear in some noun's usage — and it now covers the whole
# surface instead of one file, which is more than it checked before.
FLAGBOX=$(mktemp -d) || { echo "scrumux-tests: error: cannot create temp dir" >&2; exit 1; }
# The parsers are TypeScript; a flag is a `case '--x':` label there where it
# was a `--x)` label in the shell noun modules. Same claim, same one-file-per-
# noun shape, read from src/nouns rather than from lib/cmd-*.sh.
grep -rho -- "case '--[a-z][a-z0-9-]*'" "$ROOT/src/nouns" \
  | sed "s/^case '//; s/'$//" | sort -u > "$FLAGBOX/flags"
{ "$GOVCMD" help
  "$GOVCMD" help | sed -n 's/^  \([a-z][a-z]*\) .*/\1/p' | while read -r _n; do
    [ -n "$_n" ] && "$GOVCMD" help "$_n"
  done
} > "$FLAGBOX/help" 2>&1
NFLAGS=$(wc -l < "$FLAGBOX/flags" | tr -d ' ')
[ "$NFLAGS" -gt 20 ] && ok || bad "only $NFLAGS scrumux flags found across src/nouns — the parser scan is broken, not the help"
UNDOC=''
while read -r fl; do
  [ -n "$fl" ] || continue
  grep -qF -- "$fl" "$FLAGBOX/help" || UNDOC="$UNDOC $fl"
done < "$FLAGBOX/flags"
[ -z "$UNDOC" ] && ok || bad "scrumux accepts these flags but no noun's usage lists them:$UNDOC"
# negative control for the help sweep: a flag that cannot be in the help
grep -qF -- '--definitely-not-a-real-flag' "$FLAGBOX/help" \
  && bad "negative control: the help sweep matches anything" || ok
# the flags T-0142 found drifted are each really there, plus the
# one T-0187 added: an acceptance that does not record its authority
# is the boundary-2 failure, so the flag must be discoverable
for fl in --artifact --waives --authority; do
  grep -qF -- "$fl" "$FLAGBOX/help" \
    && ok || bad "$fl is still missing from every noun usage (T-0142 found it drifted)"
done
rm -rf "$FLAGBOX"

# --- the harness type: the upstream outbox (T-0197) -------------------
# A harness problem found while building an app must be filable as
# visibly different from the app's own code issues, so it can be pulled
# upstream later. One enum value, no new journal. The enum has FIVE
# homes (schema, records-check's own copy, scrumux's usage line, scrumux's guard and
# this suite's refusal string) and I-0030 is the record of what it costs
# when two of them disagree.
#
# Placed at the END of the suite deliberately: scrumux allocates ids in
# sequence and several assertions above name exact ids, so a case that
# creates records mid-file renumbers everything after it. This block
# creates six issues and asserts none of their ids.
HOUT=$("$GOVCMD" issue new --type harness --source claude --summary "gateway refuses the light lane" --fix "fix upstream, redeploy" 2>&1)
if [ $? -eq 0 ] && printf '%s' "$HOUT" | grep -qE '^I-[0-9]{4}$'; then ok; else bad "harness-type issue creates — got '$HOUT'"; fi
HID=$(printf '%s' "$HOUT" | tr -d '\n')
HTYPE=$(jq -r --arg i "$HID" '.entries[] | select(.id==$i) | .type' "$SANDBOX/governance/issues.json")
[ "$HTYPE" = "harness" ] && ok || bad "harness type persisted on $HID — got '$HTYPE'"
# The four original types still exist; D-0079 gates WHO may file three of
# them, so the source varies and the vocabulary does not.
for t in drift defect idea governance; do
  case "$t" in defect) who=claude ;; *) who=User ;; esac
  TOUT=$("$GOVCMD" issue new --type "$t" --source "$who" --summary "type $t" --fix F 2>&1)
  if [ $? -eq 0 ] && printf '%s' "$TOUT" | grep -qE '^I-[0-9]{4}$'; then ok; else bad "issue type $t still accepted from $who — got '$TOUT'"; fi
done
# records-check carries its OWN copy of this enum (records-check:220). A journal
# holding a harness-type issue must survive it, or the two homes have
# already drifted apart — which is exactly I-0030's failure shape.
VOUT=$(GOV_ROOT="$SANDBOX" "$ROOT/.deploy-claude/scripts/scrumux" records check 2>&1)
if printf '%s' "$VOUT" | grep -q 'invalid type harness'; then
  bad "records-check rejects the harness type — its enum copy at records-check:220 disagrees with the schema (I-0030 class)"
else
  ok
fi

# --- an agent files bugs, and nothing else (T-0209 / D-0079) ----------
# The types an agent may file are gated on SOURCE, not on the vocabulary:
# User and the app still file all five. Placed at the END for the same
# reason as the block above — these create records and scrumux allocates ids
# in sequence, so a case here cannot renumber an assertion above it.
for t in defect harness; do
  BOUT=$("$GOVCMD" issue new --type "$t" --source claude --summary "agent saw $t" --fix F 2>&1)
  if [ $? -eq 0 ] && printf '%s' "$BOUT" | grep -qE '^I-[0-9]{4}$'; then ok; else bad "an agent must be able to file --type $t — got '$BOUT'"; fi
done
for t in drift idea governance; do
  expect_fail "an agent files bugs" "agent refused --type $t" "$GOVCMD" issue new --type "$t" --source claude --summary S --fix F
  expect_fail "an agent files bugs" "implement-sop refused --type $t" "$GOVCMD" issue new --type "$t" --source implement-sop --summary S --fix F
  # User and human are unaffected: the vocabulary did not change, only who may use it.
  for who in User human; do
    DOUT=$("$GOVCMD" issue new --type "$t" --source "$who" --summary "$who files $t" --fix F 2>&1)
    if [ $? -eq 0 ] && printf '%s' "$DOUT" | grep -qE '^I-[0-9]{4}$'; then ok; else bad "$who must still be able to file --type $t — got '$DOUT'"; fi
  done
done
# The refusal has to teach, or the agent files it under a type that IS
# allowed and the noise comes back wearing a different label.
ROUT=$("$GOVCMD" issue new --type drift --source claude --summary S --fix F 2>&1)
printf '%s' "$ROUT" | grep -q -- '--type defect' \
  && ok || bad "the refusal must name --type defect as the thing to use instead; got: $ROUT"
printf '%s' "$ROUT" | grep -q 'not filed at all' \
  && ok || bad "the refusal must say the non-bug observation is not filed at all, or it reads as 'use another flag'; got: $ROUT"

# --- repair SAYS WHAT IT DID ------------------------------------------
# This block used to assert the opposite of what it asserts now, and the
# change is deliberate. `repair` called `log_new ... >/dev/null` in-line;
# `log_new` ends in `emitted` -> `emit`, and `emit` EXITS, so the whole
# process ended inside the redirect with both streams empty. Everything
# written below that call was unreachable, including a `harness verify`
# machinery check this suite asserted the PRESENCE OF -- by grepping the
# source for it, which is the one way to assert a line that never runs.
#
# So a mutating governance write, on the command reached for when a
# journal is already damaged, succeeded in TOTAL SILENCE at rc 0.
# Reported on the 2026-09-02 E2E operator run and fixed on both sides:
# `log_new` runs in a SUBSHELL (which does not fire the parent's EXIT
# trap, so $CLI_TMP survives) and the verb ends in one summary.
#
# The machinery check is REMOVED rather than revived, and that is a
# decision rather than a consequence: it had never run, so it has no
# measured behaviour and no test, and paying for a `harness verify` on
# every repair is a cost to choose deliberately. What is asserted here
# now is that it is GONE and that the summary took its place.
# CODE, not prose: the module's header explains at length WHY the check was
# removed, so a plain grep matches the explanation and reports the thing it
# is explaining. Comment lines are dropped before the search.
sed -e '/^ *\*/d' -e '/^ *\/\//d' "$ROOT/src/nouns/repair.ts" \
  | grep -q "harness', 'verify'\|harness verify" \
  && bad "the repair noun calls harness verify again - it was removed with the silence that hid it; reviving it is a ruling about what every repair costs, not a repair of this line" || ok
grep -q 'harness" deploy' "$GOVCMD" \
  && bad "scrumux repair runs deploy - a record finding would then fail the whole install (boundary 7)" || ok
"$GOVCMD" issue new --type defect --source User --summary "repair probe" --fix "none" >/dev/null 2>&1
RPO=$("$GOVCMD" repair journal issues.json --apply '.entries |= map(. + {"severity":"low"})' --why "suite probe" --by tester 2>&1); rprc=$?
[ $rprc -eq 0 ] && ok || bad "repair must succeed in a non-deployed repo - rc=$rprc: $RPO"
printf '%s' "$RPO" | grep -q 'machinery' \
  && bad "repair spoke about machinery in a repo that has none installed: $RPO" || ok
# The three facts the summary owes its caller: WHICH journal, what the
# entry count did, and the id of the log record now carrying the reason.
[ -n "$RPO" ] \
  && ok || bad "repair succeeded in TOTAL SILENCE - a mutating governance write must say what it did"
printf '%s' "$RPO" | grep -q 'repaired governance/issues.json' \
  && ok || bad "repair must name the journal it wrote: $RPO"
printf '%s' "$RPO" | grep -qE 'entries [0-9]+ -> [0-9]+' \
  && ok || bad "repair must name the entry count before and after - a repair that dropped rows is what the writer's own guard exists for: $RPO"
printf '%s' "$RPO" | grep -qE 'logged as L-[0-9]{4}' \
  && ok || bad "repair must name the log id it minted, or the record it made in the same operation is unfindable: $RPO"
# ...and the same id is in the envelope under --json, which is `emitted`'s
# own `data {id}` line crossing back out of the subshell.
RPJ=$("$GOVCMD" --json repair journal issues.json --apply '.entries |= map(. + {"severity":"medium"})' --why "suite probe json" --by tester 2>/dev/null)
printf '%s' "$RPJ" | jq -e '.ok == true and (.data.id | test("^L-[0-9]{4}$")) and (.summary | test("^repaired governance/issues.json"))' >/dev/null 2>&1 \
  && ok || bad "repair --json must carry the summary and .data.id; got: $RPJ"

# --- acceptance RE-RUNS, it does not read the receipt (I-0139) --------
# A receipt records what a command did when the agent ran it. It cannot
# record whether the command still proves what the order asked. T-0010
# arrived green with its check narrowed from ten required sections to
# eight and nothing in the machine noticed.
ACC=$(mktemp -d)/acc; mkdir -p "$ACC"; (cd "$ACC" && git init -q)
"$ROOT/.deploy-claude/scripts/scrumux" harness deploy "$ACC" >/dev/null 2>&1
printf '#!/bin/sh\nexit 0\n' > "$ACC/chk.sh"; chmod +x "$ACC/chk.sh"
( cd "$ACC"; export GOV_ROOT="$ACC"
  ./.claude/scripts/scrumux task new --title p --check "chk exits 0" >/dev/null
  ./.claude/scripts/scrumux task order T-0001 --light --scope s --verify "sh chk.sh" --file "chk.sh | probe" >/dev/null
  ./.claude/scripts/scrumux task verify T-0001 >/dev/null 2>&1
  ./.claude/scripts/scrumux decide new --title d --decision x --rationale y --by User --authority direct >/dev/null ) || true

OUT=$( cd "$ACC"; export GOV_ROOT="$ACC"; ./.claude/scripts/scrumux task accept T-0001 --by sup --authority standing:D-0001 2>&1 ); RC=$?
[ $RC -eq 0 ] && ok || bad "acceptance must succeed when the order's command still passes: $OUT"
printf '%s' "$OUT" | grep -q 're-running' \
  && ok || bad "acceptance must SAY it is re-running — a silent re-run is indistinguishable from reading the receipt"

# The case the whole mechanism exists for: receipt green, command since changed.
printf '#!/bin/sh\nexit 4\n' > "$ACC/chk.sh"
( cd "$ACC"; export GOV_ROOT="$ACC"
  ./.claude/scripts/scrumux task new --title q --check y >/dev/null
  ./.claude/scripts/scrumux task order T-0002 --light --scope s --verify "sh chk.sh" --file "chk.sh | probe" >/dev/null ) || true
# write a GREEN receipt while the command still passes, then break it
printf '#!/bin/sh\nexit 0\n' > "$ACC/chk.sh"
( cd "$ACC"; export GOV_ROOT="$ACC"; ./.claude/scripts/scrumux task verify T-0002 >/dev/null 2>&1 ) || true
printf '#!/bin/sh\nexit 4\n' > "$ACC/chk.sh"
OUT2=$( cd "$ACC"; export GOV_ROOT="$ACC"; ./.claude/scripts/scrumux task accept T-0002 --by sup --authority standing:D-0001 2>&1 ); RC2=$?
[ $RC2 -ne 0 ] && ok || bad "acceptance accepted a task whose command FAILS on re-run, on the strength of a stale green receipt"
printf '%s' "$OUT2" | grep -q 'even though its receipt is green' \
  && ok || bad "the refusal must say the receipt and the re-run disagree, or the acceptor cannot tell which to believe"

# No command to re-run is a refusal, never a quiet pass. The first cut of
# this read a field that does not exist, found nothing, skipped the
# re-run, and still printed VERIFIED.
( cd "$ACC"; export GOV_ROOT="$ACC"; ./.claude/scripts/scrumux task new --title r --check z >/dev/null ) || true
OUT3=$( cd "$ACC"; export GOV_ROOT="$ACC"; ./.claude/scripts/scrumux task accept T-0003 --by sup --authority standing:D-0001 2>&1 ); RC3=$?
[ $RC3 -ne 0 ] && ok || bad "a task with no verification_command must be REFUSED, not accepted with nothing re-run"
rm -rf "$(dirname "$ACC")"

# --- CLI-7: acceptance re-verifies the WORKTREE, not the records root --
# In a dispatched worktree the code is in the worktree while the records
# are on main. task verify (run_check) and session check both cd
# "$WORK_ROOT" to prove the delivered code; acceptance's own re-run used
# cd "$ROOT" and so re-verified the records root instead of the tree the
# work was delivered in. This case proves the re-run now runs in
# WORK_ROOT: the order's verification command tests for a file that
# exists ONLY in the worktree, so acceptance can succeed only if the
# re-run happens there. Pre-fix (cd "$ROOT") the file is absent on main
# and acceptance dies "verification command FAILED when re-run".
WTBASE=$(mktemp -d); WMAIN="$WTBASE/main"; WWT="$WTBASE/wt"
mkdir -p "$WMAIN"
( cd "$WMAIN" && git init -q && git config user.email t@t && git config user.name t )
"$GOVCMD" harness deploy "$WMAIN" >/dev/null 2>&1
( cd "$WMAIN"; export GOV_ROOT="$WMAIN"
  "$GOVCMD" task new --title p --check "wt-only file present" >/dev/null
  "$GOVCMD" task order T-0001 --light --scope s --verify "test -f wt-only.txt" --file "wt-only.txt | probe" >/dev/null )
( cd "$WMAIN" && git add -A >/dev/null 2>&1 && git commit -q -m base >/dev/null 2>&1 )
( cd "$WMAIN" && git worktree add -q -b deliver "$WWT" >/dev/null 2>&1 )
: > "$WWT/wt-only.txt"   # the delivered file — present ONLY in the worktree
# sanity: the scenario is only meaningful if main genuinely lacks the file
[ ! -f "$WMAIN/wt-only.txt" ] && [ -f "$WWT/wt-only.txt" ] \
  && ok || bad "CLI-7 setup: the verify target must exist only in the worktree, not on main"
# green receipt, produced from the worktree where the command passes
( cd "$WWT"; export GOV_ROOT="$WMAIN"; "$GOVCMD" task verify T-0001 >/dev/null 2>&1 ) || true
# accept from the worktree: succeeds ONLY if the re-run ran in WORK_ROOT
WOUT=$( cd "$WWT"; export GOV_ROOT="$WMAIN"; "$GOVCMD" task accept T-0001 --by sup --authority direct 2>&1 ); WRC=$?
[ "$WRC" -eq 0 ] \
  && ok || bad "CLI-7: acceptance re-ran the verification in the records root, not the worktree — a worktree-only check failed on re-run: $WOUT"
printf '%s' "$WOUT" | grep -q 'T-0001 accepted' \
  && ok || bad "CLI-7: the worktree acceptance must complete — got: $WOUT"
( cd "$WMAIN" && git worktree remove --force "$WWT" >/dev/null 2>&1 ) || true
rm -rf "$WTBASE"

# --- D-0084: parallel dispatch admission is per ratified sprint --------
# The cap is DECLARED AT PLANNING and lives on the sprint, so what is
# admitted is readable from the record User ratified. Three things are
# separable and all three are asserted: the flag is validated rather than
# coerced; admission counts WITHIN one ratified sprint; and the "one
# sprint at a time" refusal is untouched by the cap — a second sprint's
# task is refused however many slots the first one has.
#
# Runs against a throwaway COPY so the id sequences the cases above pin
# stay where they are (same reason as the DQ and light-lane blocks).
PP="$SANDBOX.parallel"; rm -rf "$PP"; cp -R "$SANDBOX" "$PP"
PG() { GOV_ROOT="$PP" "$GOVCMD" "$@"; }
# The fixture inherits whatever the cases above left mid-flight; this
# block is about what admission does next, not about that history.
for _t in $(jq -r '[.entries[] | select(.status=="in_progress") | .id] | join(" ")' "$PP/governance/tasks.json"); do
  PG task status "$_t" blocked >/dev/null 2>&1
done

expect_fail "must be a whole number 1 or more" "parallel 0 refused" env GOV_ROOT="$PP" "$GOVCMD" sprint new --epic E-0001 --parallel 0
expect_fail "must be a whole number 1 or more" "parallel non-numeric refused" env GOV_ROOT="$PP" "$GOVCMD" sprint new --epic E-0001 --parallel two
expect_fail "a hotfix sprint runs one task" "hotfix implies one, so an explicit cap is refused" env GOV_ROOT="$PP" "$GOVCMD" sprint new --hotfix --issue I-0001 --parallel 2

SPP=$(PG sprint new --epic E-0001 --parallel 2 2>/dev/null)
[ -n "$SPP" ] && ok || bad "parallel-lane sprint fixture was not created"
PAR=$(jq -r --arg s "$SPP" '.entries[] | select(.id==$s) | .parallel' "$PP/governance/sprints.json")
[ "$PAR" = 2 ] && ok || bad "sprint new --parallel 2 must record parallel:2 on the sprint — got '$PAR'"
SPD=$(PG sprint new --epic E-0001 2>/dev/null)
PARD=$(jq -r --arg s "$SPD" '.entries[] | select(.id==$s) | .parallel' "$PP/governance/sprints.json")
[ "$PARD" = 1 ] && ok || bad "a sprint opened with no --parallel must record parallel:1 EXPLICITLY, never null — got '$PARD'"

pmk() { # <title> -> a task with an order, ready to enter a sprint
  _i=$(PG task new --title "$1" --check "AC $1" --feature F-0001 --story S-0001 2>/dev/null)
  PG task order "$_i" --scope "$1" --verify true --out O --file "p.py | why" >/dev/null 2>&1
  printf '%s' "$_i"
}
PA=$(pmk par-a); PB=$(pmk par-b); PC=$(pmk par-c); PD=$(pmk par-d)
{ [ -n "$PA" ] && [ -n "$PB" ] && [ -n "$PC" ] && [ -n "$PD" ]; } \
  && ok || bad "parallel-lane task fixtures were not created — got '$PA' '$PB' '$PC' '$PD'"
for _t in "$PA" "$PB" "$PC"; do PG sprint add "$SPP" "$_t" >/dev/null 2>&1; done
PG sprint add "$SPD" "$PD" >/dev/null 2>&1
PG sprint ratify "$SPP" --by tester --authority direct >/dev/null 2>&1
PG sprint ratify "$SPD" --by tester --authority direct >/dev/null 2>&1

# the cap changes only while the plan is a PROPOSAL
expect_fail "re-ratification" "the cap of a ratified sprint is not an edit" env GOV_ROOT="$PP" "$GOVCMD" sprint update "$SPP" --parallel 3
SPX=$(PG sprint new --epic E-0001 2>/dev/null)
OUT=$(PG sprint update "$SPX" --parallel 3 2>&1); RC=$?
[ $RC -eq 0 ] && ok || bad "a PROPOSED sprint's cap must be changeable — rc=$RC: $OUT"
PARX=$(jq -r --arg s "$SPX" '.entries[] | select(.id==$s) | .parallel' "$PP/governance/sprints.json")
[ "$PARX" = 3 ] && ok || bad "sprint update --parallel must persist — got '$PARX'"

# admission: two in flight in a 2-slot sprint, and the third is refused
OUT=$(PG task status "$PA" in_progress 2>&1); RC=$?
[ $RC -eq 0 ] && ok || bad "the first task of a 2-slot sprint must be admitted — rc=$RC: $OUT"
OUT=$(PG task status "$PB" in_progress 2>&1); RC=$?
[ $RC -eq 0 ] && ok || bad "the SECOND task of the same 2-slot ratified sprint must be admitted (D-0084) — rc=$RC: $OUT"
OUT=$(PG task status "$PC" in_progress 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "a THIRD task must be refused when the sprint declared 2 slots — rc=$RC: $OUT"
printf '%s' "$OUT" | grep -qF "$SPP allows 2 in flight" \
  && ok || bad "the refusal must name the sprint and its cap, or the operator cannot tell it from the one-sprint rule: $OUT"
printf '%s' "$OUT" | grep -qF 'D-0084' \
  && ok || bad "the cap refusal must cite the ruling that set it, not D-0006: $OUT"

# a task in ANOTHER ratified sprint is still refused, cap or no cap
OUT=$(PG task status "$PD" in_progress 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "a task in a DIFFERENT ratified sprint must still be refused — rc=$RC: $OUT"
printf '%s' "$OUT" | grep -qF 'one sprint at a time' \
  && ok || bad "the cross-sprint refusal must say so in those words: $OUT"
printf '%s' "$OUT" | grep -qF "$SPP" \
  && ok || bad "the cross-sprint refusal must name the sprint the in-flight work belongs to: $OUT"

# a task in NO ratified sprint keeps the one-at-a-time rule
PN=$(pmk par-none)
OUT=$(PG task status "$PN" in_progress 2>&1); RC=$?
[ $RC -ne 0 ] && ok || bad "a task in no ratified sprint must keep the one-at-a-time rule — rc=$RC: $OUT"
printf '%s' "$OUT" | grep -qF 'one task at a time' \
  && ok || bad "the unsprinted refusal must be the original message, unchanged: $OUT"

# `records check` is the backstop, and 2-of-2 is a legal state
NIP=$(jq -r '[.entries[] | select(.status=="in_progress")] | length' "$PP/governance/tasks.json")
[ "$NIP" = 2 ] && ok || bad "the fixture must actually be running 2 tasks at once before records check is asked about it — got '$NIP'"
OUT=$(PG records check 2>&1); RC=$?
printf '%s' "$OUT" | grep -q 'tasks in_progress' \
  && bad "records check must not fail a sprint running inside its declared cap: $OUT" || ok

# the brief and the reject TELL report the same count, in slots
OUT=$(GOV_ROOT="$PP" "$ROOT/.deploy-claude/scripts/scrumux" task brief "$PC" 2>&1)
printf '%s' "$OUT" | grep -q 'parallel: ' \
  && ok || bad "task brief must state the sprint's parallel slots beside its other gates: $OUT"
rm -rf "$PP"

# --- every free-text refusal shows the good shape (T-0218) -----------
# User, 2026-08-30: the records agents write are terse -- "8 words, often
# acronyms or jargon" -- and acceptance criteria are vague enough to be
# argued. Where the CLI asks an agent for prose it now answers with a
# worked example drawn from a record that actually exists in this repo, so
# the agent copies the shape rather than inventing one. These assert the
# EXAMPLE is present, never its wording: a refusal that loses its example
# has lost the only part of it that teaches.
expect_fail "GOOD" "task new --title refusal carries an example"      "$GOVCMD" task new
expect_fail "GOOD" "task new --check refusal carries an example"      "$GOVCMD" task new --title X
expect_fail "GOOD" "task order --scope refusal carries an example"    "$GOVCMD" task order T-0001
expect_fail "GOOD" "task order --verify refusal carries an example"   "$GOVCMD" task order T-0001 --scope S
expect_fail "GOOD" "task order --file refusal carries an example"     "$GOVCMD" task order T-0001 --scope S --verify V
expect_fail "GOOD" "task order file-why refusal carries an example"   "$GOVCMD" task order T-0001 --scope S --verify V --file onlypath
expect_fail "GOOD" "task reject --reason refusal carries an example"  "$GOVCMD" task reject T-0001 --by tester
expect_fail "GOOD" "issue --summary refusal carries an example"       "$GOVCMD" issue new --type defect --source claude
expect_fail "GOOD" "issue --fix refusal carries an example"           "$GOVCMD" issue new --type defect --source claude --summary S
expect_fail "GOOD" "issue --evidence refusal carries an example"      "$GOVCMD" issue validate I-0001 --verdict reproduced
expect_fail "GOOD" "log --title refusal carries an example"           "$GOVCMD" log new
expect_fail "GOOD" "log --did refusal carries an example"             "$GOVCMD" log new --title X
expect_fail "GOOD" "story --narrative refusal carries an example"     "$GOVCMD" story new --feature F-0001
expect_fail "GOOD" "story --criterion refusal carries an example"     "$GOVCMD" story new --feature F-0001 --narrative N
expect_fail "GOOD" "feature --name refusal carries an example"        "$GOVCMD" feature new
expect_fail "GOOD" "feature --desc refusal carries an example"        "$GOVCMD" feature new --name X
expect_fail "GOOD" "epic --name refusal carries an example"           "$GOVCMD" epic new
expect_fail "GOOD" "epic --desc refusal carries an example"           "$GOVCMD" epic new --name X
expect_fail "GOOD" "decide --title refusal carries an example"        "$GOVCMD" decide new
expect_fail "GOOD" "decide --decision refusal carries an example"     "$GOVCMD" decide new --title T
expect_fail "GOOD" "decide --rationale refusal carries an example"    "$GOVCMD" decide new --title T --decision D
expect_fail "GOOD" "exception --lens refusal carries an example"      "$GOVCMD" exception new
expect_fail "GOOD" "exception --ref refusal carries an example"       "$GOVCMD" exception new --lens L
expect_fail "GOOD" "exception --finding refusal carries an example"   "$GOVCMD" exception new --lens L --ref R
expect_fail "GOOD" "sprint descope --reason refusal carries an example" "$GOVCMD" sprint descope SP-0001 T-0001

# ...and the usage each noun prints carries the same worked examples, so an
# agent reading the surface BEFORE it acts meets them too, not only one
# that gets refused.
for _n in task issue log story epic feature decide exception sprint; do
  if "$GOVCMD" help "$_n" 2>&1 | grep -q 'WRITING THE FREE TEXT'; then ok
  else bad "scrumux help $_n — no WRITING THE FREE TEXT block; the usage surface must show the shape of a good value, not only name the flag"; fi
done


# --- OQ-13 (D-0085): repair's refusal carries jq's own diagnostic -------
# `repair journal` is called "the most consequential write in the CLI" by
# its own code, and it is what a person reaches for when a journal is
# ALREADY damaged. Its dry run sent jq's stderr to /dev/null and then died
# with "check the filter" -- the information needed to act was computed and
# thrown away. Article 5: a refusal that states a fact without naming the
# next action is a defect.
SB_RJ=$(mktemp -d) || exit 1
mkdir -p "$SB_RJ/governance"
printf '{"entries":[{"id":"L-0001","date":"2026-01-01","title":"t","actor":"a","what_was_done":"w"}]}\n' \
  > "$SB_RJ/governance/log.json"
RJOUT=$(GOV_ROOT="$SB_RJ" "$GOVCMD" repair journal log.json --apply '.entries |= map(' --why w --by tester 2>&1); RJRC=$?
[ "$RJRC" -ne 0 ] \
  && ok || bad "OQ-13: a syntactically broken --apply filter must refuse; rc=$RJRC"
printf '%s' "$RJOUT" | grep -qiE 'syntax error|unexpected|compile error' \
  && ok || bad "OQ-13: the refusal must carry jq's own first stderr line, not only 'check the filter'; got: $RJOUT"
rm -rf "$SB_RJ"

printf 'scrumux-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "scrumux-tests: error: $FAIL assertion(s) failed — a scrumux regression; fix scrumux (or the changed contract) before proceeding, and file scrumux issue if out of scope" >&2
  exit 1
fi
exit 0
