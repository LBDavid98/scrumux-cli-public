#!/bin/sh
# status-tests.sh — T-0138: the one journal reader.
# Folds session-brief-tests, sprint-status-tests and
# the old decisions-pending-tests into one suite, because the three scripts they
# covered are now three verbs of scrumux status. Nothing was
# dropped in the fold: every case below was carried over, and the new
# cases assert the merge's own contracts — three labelled planning
# sections with three count lines and the exit codes the skills read.
# T-0186 removed the brief's untriaged line with the triage machinery
# itself, and removed scrumux's dependency on the decision queue.
#
# GOV_ROOT sandboxes throughout. Run: sh tests/status-tests.sh
set -u

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
GOVCMD="$ROOT/.deploy-claude/scripts/scrumux"
ST="$ROOT/.deploy-claude/scripts/scrumux"
ST_CMD="status"
SKILL="$ROOT/.deploy-claude/skills/session-open/SKILL.md"
SKILL_START="$ROOT/.deploy-claude/skills/session-start/SKILL.md"
SB_SESSION=$(mktemp -d) || { echo "status-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
SB_SPRINT=$(mktemp -d) || { echo "status-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
SB_QUEUE=$(mktemp -d) || { echo "status-tests: error: cannot create sandbox dir — check TMPDIR" >&2; exit 1; }
trap 'rm -rf "$SB_SESSION" "$SB_SPRINT" "$SB_QUEUE"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

# --- mode dispatch ----------------------------------------------------
export GOV_ROOT="$SB_SESSION"
OUT=$("$ST" $ST_CMD --nonsense 2>&1); rc=$?
# Exit 2, not 1: an unknown verb means the command never ran, and
# nothing was asserted either way (CLI-CONSOLIDATION.md section 4).
[ $rc -eq 2 ] && ok || bad "an unknown mode must exit 2 (could not run) — got $rc"
printf '%s' "$OUT" | grep -q 'verbs: session, planning, sprint, sweep' && ok || bad "an unknown mode must name the verbs that do exist — got: $OUT"

# =====================================================================
# --session — the orientation block (was session-brief, T-0026)
# =====================================================================

# empty repo: the brief still runs, exits 0, says no sprint
OUT=$("$ST" $ST_CMD session 2>&1); rc=$?
[ $rc -eq 0 ] && ok || bad "empty repo brief must exit 0 (got $rc)"
printf '%s' "$OUT" | grep -q 'no ratified sprint in flight' && ok || bad "empty repo should report no sprint in flight"
printf '%s' "$OUT" | grep -q 'in_progress: none' && ok || bad "empty repo should report in_progress none"

# active-sprint state: verdict flips, in-flight task listed
"$GOVCMD" feature new --name F --desc D >/dev/null
"$GOVCMD" story new --feature F-0001 --narrative N --criterion C >/dev/null
"$GOVCMD" epic new --name E --desc D --feature F-0001 >/dev/null
"$GOVCMD" task new --title "wired task" --check AC --feature F-0001 --story S-0001 >/dev/null
"$GOVCMD" task order T-0001 --scope S --verify true --out O --file "a | b" >/dev/null
"$GOVCMD" sprint new --epic E-0001 >/dev/null
"$GOVCMD" sprint add SP-0001 T-0001 >/dev/null
"$GOVCMD" sprint ratify SP-0001 --by tester --authority direct >/dev/null
"$GOVCMD" task status T-0001 in_progress >/dev/null
OUT=$("$ST" $ST_CMD session 2>&1); rc=$?
printf '%s' "$OUT" | grep -q 'working that sprint' && ok || bad "ratified-sprint state should advise working that sprint"
printf '%s' "$OUT" | grep -q 'T-0001 \[in_progress\]' && ok || bad "in-flight task should be listed under its sprint"
printf '%s' "$OUT" | grep -q 'in_progress: T-0001' && ok || bad "in_progress line should name T-0001"
# the SessionStart hook injects this into every session: a nonzero exit
# there is a session that opens on an error, so --session NEVER fails,
# not even holding the D-0004 unfinished-sprint verdict
[ $rc -eq 0 ] && ok || bad "--session must exit 0 even when a ratified sprint is unfinished (got $rc)"

# awaiting-User line: an in_review task with no acceptance counts...
# (D-0076/T-0187: the thing User rules on is the TASK, not a review)
"$GOVCMD" log new --task T-0001 --title L --did D >/dev/null
"$GOVCMD" task status T-0001 in_review >/dev/null
OUT=$("$ST" $ST_CMD session 2>&1)
printf '%s' "$OUT" | grep -q 'tasks\[T-0001\]' && ok || bad "an in_review task with no acceptance should await User — got: $OUT"
# ...and stops counting once accepted, which needs a green receipt
"$ROOT/.deploy-claude/scripts/scrumux" task verify T-0001 >/dev/null 2>&1
"$GOVCMD" task accept T-0001 --by tester --authority direct >/dev/null
OUT=$("$ST" $ST_CMD session 2>&1)
printf '%s' "$OUT" | grep -q 'tasks\[none\]' && ok || bad "an accepted task should leave the awaiting queue — got: $OUT"

# journal tails present
printf '%s' "$OUT" | grep -q 'L-0001 L' && ok || bad "log tail should show L-0001"

# T-0186: triage left the agent path with the machinery that served it.
# The brief must carry NO triage line and must not name a deleted script
# — a brief that routes a session to a missing file is worse than silent.
printf '%s\n' "$OUT" | grep -q 'untriaged' \
  && bad "the brief still prints an untriaged line — triage is app/User surface (T-0186)" || ok
printf '%s\n' "$OUT" | grep -qE 'findings-triage|health-review' \
  && bad "the brief names a script T-0186 deleted: $OUT" || ok

# compactness: the context cost budget
LINES=$("$ST" $ST_CMD session | wc -l | tr -d ' ')
[ "$LINES" -le 30 ] && ok || bad "brief is $LINES lines — budget is 30 (every line costs context in every session)"

# --- T-0163/I-0102: a corrupt journal must not read as an empty one ---
# The brief is the one reader every session opens with, and status:23
# contracts --session to never exit nonzero, so the guard is a PRINTED
# refusal rather than an exit code. Before this, a truncated tasks.json
# made the projection return empty and the brief rendered a normal-looking
# orientation with silently wrong counts; the jq parse errors went to
# stderr, which the SessionStart hook does not surface to the agent.
SB_BAD=$(mktemp -d) || { echo "status-tests: error: cannot create sandbox dir" >&2; exit 1; }
cp -R "$SB_SESSION/governance" "$SB_BAD/governance"
rm -rf "$SB_BAD/governance/.cache"
head -c 40 "$SB_SESSION/governance/tasks.json" > "$SB_BAD/governance/tasks.json"
# the fixture must actually be corrupt, or every assertion below is vacuous
jq -e . "$SB_BAD/governance/tasks.json" >/dev/null 2>&1 \
  && bad "the corrupt-journal fixture still parses — the cases below would prove nothing" || ok

OUT=$(GOV_ROOT="$SB_BAD" "$ST" $ST_CMD session 2>/dev/null); rc=$?
[ $rc -eq 0 ] && ok \
  || bad "--session must still exit 0 with a corrupt tasks.json — it is wired to SessionStart (got $rc)"
printf '%s\n' "$OUT" | grep -qF 'governance/tasks.json is not valid JSON' && ok \
  || bad "the brief does not NAME the unreadable journal (I-0102) — got: $OUT"
printf '%s\n' "$OUT" | grep -qF 'scrumux repair journal tasks.json' && ok \
  || bad "the refusal does not carry the repair command — a refusal without a fix is a dead end"
printf '%s\n' "$OUT" | grep -q 'error:' && ok \
  || bad "the refusal is not marked as an error, so it reads as ordinary brief text"
printf '%s\n' "$OUT" | grep -q 'SESSION BRIEF' && ok \
  || bad "the refusal replaced the brief instead of appearing inside it"
# emitted ONCE: tasks.json is read by load_tasks AND by jload TASKS
NREF=$(printf '%s\n' "$OUT" | grep -cF 'governance/tasks.json is not valid JSON')
[ "$NREF" = 1 ] && ok \
  || bad "the refusal for one journal printed $NREF times — a journal read by two sections must refuse once"
# and the silently-wrong counts are now accompanied by the reason
printf '%s\n' "$OUT" | grep -q 'in_progress: none' && ok \
  || bad "the empty default disappeared; the guard must keep today's fallback, only make it visible"

# a CLEAN root prints no refusal at all — absent from the happy path
OUT=$(GOV_ROOT="$SB_SESSION" "$ST" $ST_CMD session 2>/dev/null)
printf '%s\n' "$OUT" | grep -q 'is not valid JSON' \
  && bad "a clean GOV_ROOT printed a refusal line — the guard is firing on the happy path" || ok

# ABSENT is not UNREADABLE: a missing journal keeps today's behaviour
SB_GONE=$(mktemp -d) || { echo "status-tests: error: cannot create sandbox dir" >&2; exit 1; }
mkdir -p "$SB_GONE/governance"
OUT=$(GOV_ROOT="$SB_GONE" "$ST" $ST_CMD session 2>/dev/null); rc=$?
[ $rc -eq 0 ] && ok || bad "--session over an empty governance dir must exit 0 (got $rc)"
printf '%s\n' "$OUT" | grep -q 'is not valid JSON' \
  && bad "a MISSING journal was reported as unreadable — absent and corrupt are different facts" || ok

# design.json is loaded by --sprint, not --session, and gets the same
# treatment: the guard sits in load_design and not inside lib.sh
# design_view, whose other caller is records-check::sweep_structure.
SB_DES=$(mktemp -d) || { echo "status-tests: error: cannot create sandbox dir" >&2; exit 1; }
cp -R "$SB_SESSION/governance" "$SB_DES/governance"
rm -rf "$SB_DES/governance/.cache"
printf '{ broken' > "$SB_DES/governance/design.json"
OUT=$(GOV_ROOT="$SB_DES" "$ST" $ST_CMD sprint 2>/dev/null); rc=$?
[ $rc -eq 0 ] && ok || bad "--sprint must keep its exit contract with a corrupt design.json (got $rc)"
printf '%s\n' "$OUT" | grep -qF 'governance/design.json is not valid JSON' && ok \
  || bad "a corrupt design.json is not named in the sprint report — got: $OUT"
rm -rf "$SB_BAD" "$SB_GONE" "$SB_DES"

# hook wiring: SessionStart present, startup|resume matcher, no subagent-side hooks
unset GOV_ROOT
SET="$ROOT/.deploy-claude/settings.json"
jq -e '.hooks.SessionStart[0].matcher == "startup|resume"' "$SET" >/dev/null && ok || bad "SessionStart matcher must be startup|resume"
# EXEC FORM, so the argv is in .args and not in a command string. The chain
# now carries TWO hooks: the fail-closed session guard first (the walls'
# `command -v node || exit 2` had nowhere to live once the wall chains went
# exec form, and SessionStart is the one event that fires before any tool
# call), then the session brief. Asserted over the whole chain rather than
# at [0], so adding a hook cannot silently displace the brief.
jq -e '[.hooks.SessionStart[0].hooks[] | select(.command == "node")
        | (.args | join(" "))] | any(endswith("scrumux.mjs status session"))' "$SET" >/dev/null \
  && ok || bad "SessionStart must run scrumux status session, in exec form"
jq -e '[.hooks.SessionStart[0].hooks[] | (.args // [])[0]]
        | any(endswith("/session-guard.mjs"))' "$SET" >/dev/null \
  && ok || bad "SessionStart must carry the fail-closed session guard — exec form cannot hold the shim's node check"
jq -e '.hooks | has("SubagentStart") or has("SubagentStop") | not' "$SET" >/dev/null && ok || bad "no subagent-side hooks should exist (subagents are never briefed)"

# =====================================================================
# --sprint / --planning — the sprint report (was sprint-status, T-0094)
# =====================================================================
export GOV_ROOT="$SB_SPRINT"

# --- fixture: one epic, one feature, two ordered tasks ----------------
"$GOVCMD" feature new --name Feat --desc D >/dev/null 2>&1
"$GOVCMD" story new --feature F-0001 --narrative N --criterion C >/dev/null 2>&1
"$GOVCMD" epic new --name Ep --desc D --feature F-0001 >/dev/null 2>&1
for n in 1 2; do
  "$GOVCMD" task new --title "T$n" --check "AC$n" --feature F-0001 --story S-0001 >/dev/null 2>&1
  "$GOVCMD" task order "T-000$n" --story S-0001 --scope S --verify "true" --out O --file "a.py | why" >/dev/null 2>&1
done

# --- with no sprint in flight, both are candidates --------------------
OUT=$("$ST" $ST_CMD sprint 2>&1); RC=$?
[ $RC -eq 0 ] && ok || bad "clear-to-plan must exit 0 — rc=$RC"
printf '%s' "$OUT" | grep -q 'T-0001' && ok || bad "an unsprinted ready task must be a candidate"
printf '%s' "$OUT" | grep -q 'T-0002' && ok || bad "the second unsprinted task must be a candidate too"
printf '%s' "$OUT" | grep -q 'READY: scrumux sprint add' \
  && ok || bad "a ready candidate must carry the add hint"

# a task missing its order is named as not sprint-ready
"$GOVCMD" task new --title "T3 unordered" --check AC3 --feature F-0001 --story S-0001 >/dev/null 2>&1
OUT=$("$ST" $ST_CMD sprint 2>&1)
printf '%s' "$OUT" | sed -n '/not sprint-ready/,/Open issues/p' | grep -q 'T-0003.*MISSING order' \
  && ok || bad "an unordered task must be listed as not sprint-ready with the scrumux task order command"

# --- I-0039: once sprinted, a task is NOT a candidate -----------------
"$GOVCMD" sprint new --epic E-0001 >/dev/null 2>&1
"$GOVCMD" sprint add SP-0001 T-0001 >/dev/null 2>&1
OUT=$("$ST" $ST_CMD sprint 2>&1)
CAND=$(printf '%s' "$OUT" | sed -n '/Candidates for next sprint/,$p')
printf '%s' "$CAND" | grep -q 'T-0001' \
  && bad "a task carried by a live sprint must NOT be offered as a candidate (I-0039): $CAND" || ok
printf '%s' "$CAND" | grep -q 'T-0002' \
  && ok || bad "the task still outside the sprint must remain a candidate"
# and it must still appear in the in-flight block — excluded from
# candidates is not the same as hidden
printf '%s' "$OUT" | sed -n '/Sprints in flight/,/Epic coverage/p' | grep -q 'T-0001' \
  && ok || bad "a sprinted task must still show under Sprints in flight"

# --- a ratified sprint with unfinished tasks stops planning (D-0004) --
"$GOVCMD" sprint ratify SP-0001 --by tester >/dev/null 2>&1
"$ST" $ST_CMD sprint >/dev/null 2>&1
[ $? -eq 0 ] && ok || bad "a ratified sprint with unfinished tasks must exit 0 and TELL (T-0144 made the D-0004 gate advice)"
# the same verdict is the WHOLE planning report's exit code: sprint-plan
# Step 1 and planning-agent.md:40 stop on 3 however the other two
# sections read
"$ST" $ST_CMD planning >/dev/null 2>&1
[ $? -eq 0 ] && ok || bad "--planning must exit 0 and TELL (T-0144)"

# --- an abandoned sprint releases its tasks back to candidates --------
"$GOVCMD" sprint status SP-0001 abandoned >/dev/null 2>&1
OUT=$("$ST" $ST_CMD sprint 2>&1)
printf '%s' "$OUT" | sed -n '/Candidates for next sprint/,$p' | grep -q 'T-0001' \
  && ok || bad "an abandoned sprint must release its tasks back to the candidate list"
"$ST" $ST_CMD sprint >/dev/null 2>&1
[ $? -eq 0 ] && ok || bad "with nothing ratified in flight, --sprint must exit 0"

# --- the merged report keeps its labelled sections --------------------
# The skill gates BETWEEN steps on each section's own count line, so one
# blended report with a single total would destroy the signal. The
# decision-queue section that sat between these two is gone.
OUT=$("$ST" $ST_CMD planning 2>&1); rc=$?
[ $rc -eq 0 ] && ok || bad "--planning with nothing ratified must exit 0 — got $rc"
printf '%s\n' "$OUT" | grep -q '^=== SPRINT STATUS' && ok || bad "--planning must label the sprint section"
printf '%s\n' "$OUT" | grep -q '^=== ISSUES PENDING VALIDATION' && ok || bad "--planning must label the validation-sweep section"
printf '%s\n' "$OUT" | grep -q '^VERDICT:' && ok || bad "--planning must carry the sprint verdict line"
NCOUNT=$(printf '%s\n' "$OUT" | grep -c '^pending: ')
[ "$NCOUNT" = 1 ] && ok || bad "the validation sweep keeps its own 'pending: N' line — found $NCOUNT, want 1"
# sections in the order the skill works them (D-0016 after the verdict)
LS=$(printf '%s\n' "$OUT" | grep -n '^=== ' | sed -n '2p' | cut -d: -f1)
LV=$(printf '%s\n' "$OUT" | grep -n '^=== ' | sed -n '3p' | cut -d: -f1)
[ -n "$LS" ] && [ -n "$LV" ] && [ "$LS" -lt "$LV" ] \
  && ok || bad "planning sections must read sprint -> sweep — got $LS/$LV"

export GOV_ROOT="$SB_QUEUE"

# The decision-queue sections lived here: the queue itself, its
# User-only skill contract, the recorded-hold cases, the push-hold
# case, the per-item ruling payload, and the repeat-ask flag. The
# queue and its asks.json counter are gone — 8 rows counting how often
# another record had been shown to User.

# --- --decisions is refused now that the queue is gone ----------------
OUT=$("$ST" $ST_CMD --decisions 2>&1); rc=$?
[ $rc -ne 0 ] && printf '%s' "$OUT" | grep -q 'verbs: session, planning, sprint, sweep' && ok || bad "--decisions must be refused, naming the verbs that do exist — rc=$rc: $OUT"

# --- skill contract: session-start routes on the lines the brief prints
# T-0194: acceptance re-homed from the review record to the task
# (D-0076/T-0187) and the brief's queue line became `awaiting User:
# tasks[...]`, but the routing table still documented `reviews[...]` —
# a line status has not emitted since. A route keyed on a line that
# never appears is a route never taken, so the queue it points at goes
# unsurfaced. The assertions pin the table to what --session actually
# prints (asserted above) and to the command that clears the queue.
grep -q 'reviews\[' "$SKILL_START" \
  && bad "session-start routes on 'reviews[...]' — status prints 'tasks[...]'; the review record stopped being the thing accepted (D-0076/T-0187)" || ok
grep -q 'awaiting User: tasks\[' "$SKILL_START" \
  && ok || bad "session-start must route on the brief's actual queue line, 'awaiting User: tasks[...]'"
grep -q 'scrumux task accept T-XXXX' "$SKILL_START" \
  && ok || bad "session-start must name the command that clears the queue (scrumux task accept T-XXXX --authority), which is User's alone"

# --- the brief hides nothing (T-0204 / I-0122) ------------------------
# status:427 used to end in `| head -8`: one header line plus seven
# tasks, silently dropped, from the surface D-0073 names as the agent's.
# The cap counted HEADERS and spanned every in-flight sprint, so the
# failure was never simply "more than seven tasks". Both shapes are
# covered here — nine tasks in one sprint, and two sprints of five —
# and the counts are 9 and 5+5 rather than 8 and 4+4 so that neither
# case could pass by sitting exactly at the old boundary.
SB_BIG=$(mktemp -d) || { echo "status-tests: cannot mktemp" >&2; exit 1; }
mkdir -p "$SB_BIG/governance"
python3 - "$SB_BIG/governance" <<'PYEOF'
import json, sys
d = sys.argv[1]
tasks = [{"id": "T-%04d" % i, "title": "task %d" % i, "status": "proposed",
          "feature": "F-0001", "story": "S-0001"} for i in range(1, 10)]
json.dump({"entries": tasks}, open(d + "/tasks.json", "w"))
json.dump({"entries": [{"id": "SP-9001", "status": "ratified", "epic": "E-0001",
                        "tasks": [t["id"] for t in tasks]}]},
          open(d + "/sprints.json", "w"))
PYEOF
BIGOUT=$(GOV_ROOT="$SB_BIG" "$ST" $ST_CMD session 2>&1)
MISS=''
for i in 1 2 3 4 5 6 7 8 9; do
  printf '%s' "$BIGOUT" | grep -q "T-000$i" || MISS="$MISS T-000$i"
done
[ -z "$MISS" ] && ok || bad "the session brief dropped task(s)$MISS from a 9-task sprint — silent truncation is what I-0122 recorded"
# and the two views must agree, which is the comparison that proved the bug
# --sprint prints a second '  T-' block (Backlog tasks not sprint-ready),
# so the comparison is scoped to the in-flight section or it counts the
# same tasks twice.
BIGSPRINT=$(GOV_ROOT="$SB_BIG" "$ST" $ST_CMD sprint 2>&1 | awk '/--- Sprints in flight ---/,/^$/')
NB=$(printf '%s' "$BIGOUT" | grep -c '^  T-')
NS=$(printf '%s' "$BIGSPRINT" | grep -c '^  T-')
[ "$NB" = "$NS" ] \
  && ok || bad "--session lists $NB task(s) and --sprint lists $NS for the same sprint — two views of one record must not disagree"

# Two in-flight sprints: the shape the cap hid worst, because it counted
# the second sprint's HEADER against the same budget.
python3 - "$SB_BIG/governance" <<'PYEOF'
import json, sys
d = sys.argv[1]
tasks = [{"id": "T-%04d" % i, "title": "task %d" % i, "status": "proposed",
          "feature": "F-0001", "story": "S-0001"} for i in range(1, 11)]
json.dump({"entries": tasks}, open(d + "/tasks.json", "w"))
json.dump({"entries": [
    {"id": "SP-9001", "status": "ratified", "epic": "E-0001",
     "tasks": ["T-%04d" % i for i in range(1, 6)]},
    {"id": "SP-9002", "status": "proposed", "epic": "E-0001",
     "tasks": ["T-%04d" % i for i in range(6, 11)]}]},
          open(d + "/sprints.json", "w"))
PYEOF
TWOOUT=$(GOV_ROOT="$SB_BIG" "$ST" $ST_CMD session 2>&1)
printf '%s' "$TWOOUT" | grep -q 'SP-9002' \
  && ok || bad "the second in-flight sprint's header never reached the brief — the old cap counted headers against the same budget"
MISS=''
for i in 1 2 3 4 5 6 7 8 9; do
  printf '%s' "$TWOOUT" | grep -q "T-000$i" || MISS="$MISS T-000$i"
done
printf '%s' "$TWOOUT" | grep -q "T-0010" || MISS="$MISS T-0010"
[ -z "$MISS" ] && ok || bad "with two in-flight sprints the brief dropped task(s)$MISS"

# The grep the cap sat behind is load-bearing and must survive: a title
# carrying a newline emits a continuation line that --sprint prints bare.
python3 - "$SB_BIG/governance" <<'PYEOF'
import json, sys
d = sys.argv[1]
json.dump({"entries": [{"id": "T-0001", "title": "first line\nSMUGGLED CONTINUATION",
                        "status": "proposed", "feature": "F-0001", "story": "S-0001"}]},
          open(d + "/tasks.json", "w"))
json.dump({"entries": [{"id": "SP-9001", "status": "ratified", "epic": "E-0001",
                        "tasks": ["T-0001"]}]}, open(d + "/sprints.json", "w"))
PYEOF
NLOUT=$(GOV_ROOT="$SB_BIG" "$ST" $ST_CMD session 2>&1)
printf '%s' "$NLOUT" | grep -q '^SMUGGLED CONTINUATION' \
  && bad "a newline in a task title leaked a bare continuation line into the brief — the grep filter was removed with the cap" || ok
rm -rf "$SB_BIG"


# --- PK-4 (D-0085): the brief's git position must appear in a worktree ---
# Same `[ -d "$ROOT/.git" ]` defect as PK-3, in section_session: inside a
# worktree the commit line was omitted entirely, so an agent's first message
# of the session was oriented with no git position at all and nothing said so.
SB_WT_MAIN=$(mktemp -d) || exit 1
(cd "$SB_WT_MAIN" && git init -q -b main && printf 'x\n' > a.txt && git add -A \
  && git -c user.email=t@t -c user.name=t commit -qm init >/dev/null 2>&1)
SB_WT="$SB_WT_MAIN/wt"
if (cd "$SB_WT_MAIN" && git worktree add -q "$SB_WT" -b wtbranch >/dev/null 2>&1) && [ -f "$SB_WT/.git" ]; then
  mkdir -p "$SB_WT/governance"
  OUTWT=$(cd "$SB_WT" && GOV_ROOT="$SB_WT" WORK_ROOT="$SB_WT" "$ST" $ST_CMD session 2>/dev/null)
  printf '%s' "$OUTWT" | grep -q '^commit: ' \
    && ok || bad "PK-4: status session in a worktree must still print the commit line (.git is a FILE there); got: $(printf '%s' "$OUTWT" | head -3)"
  (cd "$SB_WT_MAIN" && git worktree remove --force "$SB_WT" >/dev/null 2>&1)
else
  bad "PK-4: could not build the worktree fixture (git worktree add failed)"
fi
rm -rf "$SB_WT_MAIN"

printf 'status-tests: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "status-tests: error: $FAIL case(s) wrong — fix .claude/scripts/scrumux status before trusting session orientation or the planning gates" >&2
  exit 1
fi
exit 0
